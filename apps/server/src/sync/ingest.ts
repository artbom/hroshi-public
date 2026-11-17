import { countDaysBetween, findMatchingRule, type MatchableRule, shiftDate } from '@hroshi/domain';
import type { Currency, Source, SyncSource, TransactionType } from '@hroshi/schema';

import type { Db } from '../db.ts';
import type { Account as AccountRow, Prisma, Transaction as TransactionRow } from '../generated/prisma/client.ts';
import { fromIsoDate, mapRule, toIsoDate, toNullableNumber, toNumber } from '../mappers.ts';
import { normalizeIban, roundMoney, type StatementItem } from './statement.ts';
import type { SyncCounts } from './types.ts';

/** Bank amounts are exact to the cent; anything beyond is rounding. */
const AMOUNT_TOLERANCE = 0.005;
/** Hand entries are often typed in whole units or estimated from a foreign-currency receipt. */
const LOOSE_AMOUNT_MIN = 1;
const LOOSE_AMOUNT_RATIO = 0.015;
/** A hand entry is dated by the receipt, the bank books a day or two later. */
const MATCH_WINDOW_DAYS = 2;
/** A hand entry this close in amount on the same account and days is probably the same purchase, estimated. */
const DUPLICATE_SUSPICION_RATIO = 0.15;
/** Rows a bank line may claim: owner-entered or imported, never another provider's line. */
const ADOPTABLE_SOURCES: Source[] = ['claude', 'page', 'zenmoney'];
/** Hand entries and history rows a bank line may adopt; split rows and their parts are the owner's answer already. */
const UNSPLIT = { splitOfId: null, splits: { none: {} } } satisfies Prisma.TransactionWhereInput;

const ATM_MCC = 6011;
/** A card-to-card top-up shows up on the receiving bank within a few days. */
const STRAY_INFLOW_DAYS = 3;
const PERSON_TRANSFER_MCC = 4829;
const FALLBACK_CATEGORY = 'Інше';
const ATM_FEE_CATEGORY = 'Послуги';
/** Mono books a released hold or a refund as "Скасування. <merchant>". */
const CANCELLATION_PREFIX = /^скасування\.?\s*/iu;
/** Card holds (hotels, car rental) are released within weeks. */
const CANCELLATION_LOOKBACK_DAYS = 45;
/** Mono describes a card-to-card payment by the recipient's masked number: 537541******1234. */
const MASKED_CARD = /^\d{4,6}\*{4,}(\d{4})$/;

type Draft = {
  type: TransactionType;
  accountId: string;
  amount: number;
  currency: Currency;
  toAccountId: string | null;
  toAmount: number | null;
  toCurrency: Currency | null;
  category: string | null;
  reviewReason: string | null;
  /** The bank's structure wins over a hand entry (own-account legs through the ФОП UAH pass-through). */
  authoritative: boolean;
};

type Ingestion = {
  db: Db;
  source: SyncSource;
  dismissed: ReadonlySet<string>;
  accounts: ReadonlyMap<string, AccountRow>;
  accountsByIban: ReadonlyMap<string, AccountRow>;
  rules: readonly MatchableRule[];
  counts: SyncCounts;
  /** Rows created in this run; duplicate checks wait until every line had its chance to claim a hand entry. */
  created: string[];
};

export const prefixExternalId = (source: SyncSource, id: string): string => `${source}:${id}`;

const requireAccount = (ingestion: Ingestion, id: string): AccountRow => {
  const account = ingestion.accounts.get(id);
  if (account === undefined) throw new Error(`Statement for unknown account "${id}"`);
  return account;
};

const findCounterAccount = (ingestion: Ingestion, item: StatementItem): AccountRow | undefined => {
  if (item.counterAccountId !== undefined) return ingestion.accounts.get(item.counterAccountId);
  if (item.counterIban === null) return undefined;
  const counter = ingestion.accountsByIban.get(normalizeIban(item.counterIban));
  return counter?.id === item.accountId ? undefined : counter;
};

const createDateWindow = (date: string) => ({
  gte: fromIsoDate(shiftDate(date, -MATCH_WINDOW_DAYS)),
  lte: fromIsoDate(shiftDate(date, MATCH_WINDOW_DAYS)),
});

const createAmountRange = (amount: number) => ({ gte: amount - AMOUNT_TOLERANCE, lte: amount + AMOUNT_TOLERANCE });

const createRoundingRange = (amount: number) => ({ gte: amount - LOOSE_AMOUNT_MIN, lte: amount + LOOSE_AMOUNT_MIN });

const createLooseAmountRange = (amount: number) => {
  const slack = Math.max(LOOSE_AMOUNT_MIN, amount * LOOSE_AMOUNT_RATIO);
  return { gte: amount - slack, lte: amount + slack };
};

const pickClosest = <TRow extends Pick<TransactionRow, 'date'>>(rows: TRow[], date: string): TRow | undefined =>
  rows.toSorted(
    (left, right) =>
      Math.abs(countDaysBetween(toIsoDate(left.date), date)) - Math.abs(countDaysBetween(toIsoDate(right.date), date)),
  )[0];

const tokenize = (text: string): Set<string> =>
  new Set(
    text
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLocaleLowerCase('uk')
      .match(/\p{L}{3,}/gu) ?? [],
  );

const sharesWord = (left: string, right: string): boolean => {
  const words = tokenize(right);
  return [...tokenize(left)].some((word) => words.has(word));
};

/**
 * Exact amounts win. Otherwise a hand entry needs a word in common with the bank line
 * ("Bolt · Лісабон" ↔ "Bolt") to be off by up to the loose ratio (an estimate); without one
 * it may only differ by rounding, or a 780 ₴ car-rental note would claim a 772.96 ₴ dinner.
 */
const pickBestMatch = <TRow extends Pick<TransactionRow, 'date' | 'note'>>({
  rows,
  item,
  readAmount,
  expected,
}: {
  rows: TRow[];
  item: StatementItem;
  readAmount: (row: TRow) => number;
  expected: number;
}): TRow | undefined => {
  const exact = rows.filter((row) => Math.abs(readAmount(row) - expected) <= AMOUNT_TOLERANCE);
  const bankText = [item.description, item.counterparty ?? ''].join(' ');
  const pool = exact.length > 0 ? exact : rows;
  const worded = pool.filter((row) => sharesWord(row.note ?? '', bankText));
  if (worded.length > 0) return pickClosest(worded, item.date);
  if (exact.length > 0) return pickClosest(exact, item.date);
  const rounded = rows.filter((row) => Math.abs(readAmount(row) - expected) <= LOOSE_AMOUNT_MIN);
  return rounded.length === 1 ? rounded[0] : undefined;
};

/** What arrives on `target` when the item leaves `account`: same currency needs no figure, else the bank's operation amount. */
const resolveCreditedAmount = ({
  item,
  account,
  target,
}: {
  item: StatementItem;
  account: AccountRow;
  target: AccountRow;
}): number | null => {
  if (target.currency === account.currency) return null;
  if (item.operationCurrency === target.currency && item.operationAmount !== null) {
    return Math.abs(item.operationAmount);
  }
  return 0;
};

const draftTransferOut = ({
  item,
  account,
  target,
  amount = Math.abs(item.amount),
  authoritative,
}: {
  item: StatementItem;
  account: AccountRow;
  target: AccountRow;
  amount?: number;
  authoritative: boolean;
}): Draft => {
  const toAmount = resolveCreditedAmount({ item, account, target });
  return {
    type: 'transfer',
    accountId: account.id,
    amount,
    currency: account.currency,
    toAccountId: target.id,
    toAmount,
    toCurrency: target.currency,
    category: null,
    reviewReason: toAmount === 0 ? `Невідома сума зарахування на «${target.name}»` : null,
    authoritative,
  };
};

/** Money back from an account the bank cannot see into (a broker paying out). */
const draftTransferIn = ({ item, account, source }: { item: StatementItem; account: AccountRow; source: AccountRow }): Draft => {
  const sent =
    source.currency === account.currency
      ? item.amount
      : item.operationCurrency === source.currency && item.operationAmount !== null
        ? Math.abs(item.operationAmount)
        : null;
  return {
    type: 'transfer',
    accountId: source.id,
    amount: sent ?? item.amount,
    currency: source.currency,
    toAccountId: account.id,
    toAmount: source.currency === account.currency ? null : item.amount,
    toCurrency: account.currency,
    category: null,
    reviewReason: sent === null ? `Невідома сума списання з «${source.name}»` : null,
    authoritative: false,
  };
};

/**
 * Revolut keeps one account per currency; dollars sent to the Revolut card land in the USD pocket,
 * not in the euro account a rule names.
 */
const resolvePocket = ({
  ingestion,
  account,
  item,
  source,
}: {
  ingestion: Ingestion;
  account: AccountRow;
  item: StatementItem;
  source: AccountRow;
}): AccountRow => {
  const currency = item.operationCurrency ?? source.currency;
  if (account.syncSource === null || account.currency === currency) return account;
  return (
    [...ingestion.accounts.values()].find(
      (candidate) => candidate.syncSource === account.syncSource && candidate.bank === account.bank && candidate.currency === currency,
    ) ?? account
  );
};

const draftCategorised = ({
  item,
  account,
  category,
  reviewReason = null,
}: {
  item: StatementItem;
  account: AccountRow;
  category: string;
  reviewReason?: string | null;
}): Draft => ({
  type: item.amount < 0 ? 'expense' : 'income',
  accountId: account.id,
  amount: Math.abs(item.amount),
  currency: account.currency,
  toAccountId: null,
  toAmount: null,
  toCurrency: null,
  category,
  reviewReason,
  authoritative: false,
});

/** Cash comes out as a transfer to the cash wallet; what the bank charged on top is a separate fee expense. */
const draftAtmWithdrawal = ({
  ingestion,
  item,
  account,
}: {
  ingestion: Ingestion;
  item: StatementItem;
  account: AccountRow;
}): Map<string, Draft> | undefined => {
  const cashCurrency = item.operationCurrency ?? account.currency;
  const cash = [...ingestion.accounts.values()].find(
    (candidate) => candidate.kind === 'cash' && !candidate.archived && candidate.currency === cashCurrency,
  );
  if (cash === undefined) return undefined;
  if (cash.currency !== account.currency || item.operationAmount === null) {
    return new Map([['', draftTransferOut({ item, account, target: cash, authoritative: true })]]);
  }

  const received = Math.abs(item.operationAmount);
  const fee = roundMoney(Math.abs(item.amount) - received);
  const drafts = new Map([['', draftTransferOut({ item, account, target: cash, amount: received, authoritative: true })]]);
  if (fee > 0) {
    drafts.set(':fee', draftCategorised({ item: { ...item, amount: -fee }, account, category: ATM_FEE_CATEGORY }));
  }
  return drafts;
};

const describeUnmatched = (item: StatementItem): string => {
  if (/розстрочк/iu.test(item.description) || /погашення/iu.test(item.description)) {
    return 'Розстрочка: віднеси до категорії початкової покупки';
  }
  if (item.amount > 0) return `Невідомий дохід «${item.description}»`;
  const card = item.description.match(MASKED_CARD)?.[1];
  if (card !== undefined) return `Переказ на картку •${card}: власна картка, P2P чи людині? Це не витрата, якщо картка твоя`;
  if (item.mcc === PERSON_TRANSFER_MCC && item.counterparty !== null) {
    return `Переказ людині (${item.counterparty}): Binance P2P, Оля, борг?`;
  }
  return `Немає правила для «${item.description}»${item.mcc === null ? '' : ` (MCC ${item.mcc})`}`;
};

/**
 * A cancellation belongs to the category of the purchase it reverses. When both are unknown
 * and cancel out exactly, neither needs the owner's attention.
 */
const draftCancellation = async ({
  ingestion,
  item,
  account,
}: {
  ingestion: Ingestion;
  item: StatementItem;
  account: AccountRow;
}): Promise<Draft | undefined> => {
  if (item.amount <= 0 || !CANCELLATION_PREFIX.test(item.description)) return undefined;
  const original = await ingestion.db.transaction.findFirst({
    where: {
      accountId: account.id,
      type: 'expense',
      note: item.description.replace(CANCELLATION_PREFIX, '').trim(),
      date: { gte: fromIsoDate(shiftDate(item.date, -CANCELLATION_LOOKBACK_DAYS)), lte: fromIsoDate(item.date) },
    },
    orderBy: { date: 'desc' },
  });
  if (original === null) return undefined;

  const cancelsExactly = Math.abs(toNumber(original.amount) - item.amount) < AMOUNT_TOLERANCE;
  if (original.needsReview && cancelsExactly) {
    await ingestion.db.transaction.update({
      where: { id: original.id },
      data: { needsReview: false, reviewReason: null },
    });
  }
  return draftCategorised({
    item,
    account,
    category: original.category ?? FALLBACK_CATEGORY,
    reviewReason: original.needsReview && !cancelsExactly ? 'Часткове скасування покупки, що чекає на перевірку' : null,
  });
};

const draftItem = async ({
  ingestion,
  item,
  account,
}: {
  ingestion: Ingestion;
  item: StatementItem;
  account: AccountRow;
}): Promise<Map<string, Draft>> => {
  const counter = findCounterAccount(ingestion, item);
  if (counter !== undefined) return new Map([['', draftTransferOut({ item, account, target: counter, authoritative: true })]]);

  if (item.mcc === ATM_MCC && item.amount < 0) {
    const atm = draftAtmWithdrawal({ ingestion, item, account });
    if (atm !== undefined) return atm;
  }

  const rule = findMatchingRule(ingestion.rules, {
    accountId: account.id,
    mcc: item.mcc,
    texts: [item.description, item.counterparty, item.comment],
  });
  if (rule?.transferToAccountId != null) {
    const pocket = resolvePocket({ ingestion, account: requireAccount(ingestion, rule.transferToAccountId), item, source: account });
    return new Map([
      ['', item.amount < 0 ? draftTransferOut({ item, account, target: pocket, authoritative: false }) : draftTransferIn({ item, account, source: pocket })],
    ]);
  }
  if (rule?.category != null) return new Map([['', draftCategorised({ item, account, category: rule.category })]]);

  const cancellation = await draftCancellation({ ingestion, item, account });
  if (cancellation !== undefined) return new Map([['', cancellation]]);

  return new Map([
    ['', draftCategorised({ item, account, category: FALLBACK_CATEGORY, reviewReason: describeUnmatched(item) })],
  ]);
};

/** A row already standing for this money: a hand entry, a history row, or a transfer created from its other leg. */
const findOutflowCandidate = async ({ ingestion, item, draft }: { ingestion: Ingestion; item: StatementItem; draft: Draft }) => {
  const rows = await ingestion.db.transaction.findMany({
    where: {
      accountId: draft.accountId,
      externalId: null,
      date: createDateWindow(item.date),
      OR: [
        // A hand-entered transfer is often rounded to whole hryvnias (2 221 for 2 221.50).
        { type: 'transfer', amount: createRoundingRange(draft.amount) },
        { type: 'expense', source: { in: ADOPTABLE_SOURCES }, amount: createLooseAmountRange(draft.amount), ...UNSPLIT },
      ],
    },
  });
  const sameTarget = rows.filter((row) => row.toAccountId !== null && row.toAccountId === draft.toAccountId);
  return pickBestMatch({
    rows: sameTarget.length > 0 ? sameTarget : rows,
    item,
    readAmount: (row) => toNumber(row.amount),
    expected: draft.amount,
  });
};

const findInflowCandidate = async ({ ingestion, item, draft }: { ingestion: Ingestion; item: StatementItem; draft: Draft }) => {
  const range = createAmountRange(draft.amount);
  const rows = await ingestion.db.transaction.findMany({
    where: {
      date: createDateWindow(item.date),
      OR: [
        {
          type: 'income',
          accountId: draft.accountId,
          externalId: null,
          source: { in: ADOPTABLE_SOURCES },
          amount: createLooseAmountRange(draft.amount),
          ...UNSPLIT,
        },
        {
          type: 'transfer',
          toAccountId: draft.accountId,
          toExternalId: null,
          OR: [{ toAmount: range }, { toAmount: null, amount: range }],
        },
      ],
    },
  });
  return pickBestMatch({
    rows,
    item,
    readAmount: (row) =>
      row.type === 'transfer' ? (toNullableNumber(row.toAmount) ?? toNumber(row.amount)) : toNumber(row.amount),
    expected: draft.amount,
  });
};

const claimRow = async ({
  ingestion,
  item,
  draft,
  candidate,
  externalId,
}: {
  ingestion: Ingestion;
  item: StatementItem;
  draft: Draft;
  candidate: TransactionRow;
  externalId: string;
}) => {
  const incomingLeg = item.amount > 0 && candidate.type === 'transfer' && candidate.toAccountId === draft.accountId;
  const structure = draft.authoritative
    ? {
        type: draft.type,
        toAccountId: draft.toAccountId,
        toAmount: draft.toAmount,
        toCurrency: draft.toCurrency,
        category: draft.category,
      }
    : {};
  const data: Prisma.TransactionUpdateInput = incomingLeg
    ? { toExternalId: externalId, ...(toNullableNumber(candidate.toAmount) === 0 ? { toAmount: draft.amount } : {}) }
    : {
        externalId,
        amount: draft.amount,
        raw: item.raw,
        ...structure,
        ...(candidate.category === null && draft.category !== null && !draft.authoritative ? { category: draft.category } : {}),
      };
  await ingestion.db.transaction.update({ where: { id: candidate.id }, data });
  ingestion.counts.updated += 1;
};

/** Flags a new line that looks like a hand entry with an estimated amount, so the owner deletes one of them. */
const flagSuspectedDuplicate = async ({ ingestion, id }: { ingestion: Ingestion; id: string }) => {
  const row = await ingestion.db.transaction.findUnique({ where: { id } });
  if (row === null || (row.type !== 'expense' && row.type !== 'income')) return;
  const amount = toNumber(row.amount);
  const twin = await ingestion.db.transaction.findFirst({
    where: {
      id: { not: row.id },
      accountId: row.accountId,
      type: row.type,
      externalId: null,
      source: { in: ADOPTABLE_SOURCES },
      ...UNSPLIT,
      date: createDateWindow(toIsoDate(row.date)),
      amount: { gte: amount * (1 - DUPLICATE_SUSPICION_RATIO), lte: amount * (1 + DUPLICATE_SUSPICION_RATIO) },
    },
  });
  if (twin === null) return;
  await ingestion.db.transaction.update({
    where: { id: row.id },
    data: {
      needsReview: true,
      duplicateOfId: twin.id,
      reviewReason: `Можливий дубль запису «${twin.note ?? twin.category ?? ''}» (${toNumber(twin.amount)} ${twin.currency}, ${toIsoDate(twin.date)})`,
    },
  });
};

const createRow = async ({
  ingestion,
  item,
  draft,
  externalId,
  incomingLeg = false,
}: {
  ingestion: Ingestion;
  item: StatementItem;
  draft: Draft;
  externalId: string;
  incomingLeg?: boolean;
}) => {
  const row = await ingestion.db.transaction.create({
    data: {
      type: draft.type,
      date: fromIsoDate(item.date),
      accountId: draft.accountId,
      amount: draft.amount,
      currency: draft.currency,
      toAccountId: draft.toAccountId,
      toAmount: draft.toAmount,
      toCurrency: draft.toCurrency,
      category: draft.category,
      note: item.description,
      source: ingestion.source,
      ...(incomingLeg ? { toExternalId: externalId } : { externalId }),
      needsReview: draft.reviewReason !== null,
      reviewReason: draft.reviewReason,
      raw: item.raw,
    },
  });
  ingestion.counts.created += 1;
  ingestion.created.push(row.id);
};

/** What a transfer put into its target account: the known credit, else the amount sent. */
const readCreditedAmount = (row: Pick<TransactionRow, 'amount' | 'toAmount'>) => toNullableNumber(row.toAmount) ?? toNumber(row.amount);

const ingestOwnInflow = async ({
  ingestion,
  item,
  account,
  counter,
  externalId,
}: {
  ingestion: Ingestion;
  item: StatementItem;
  account: AccountRow;
  counter: AccountRow;
  externalId: string;
}) => {
  const received = item.amount;
  const sameCurrency = counter.currency === account.currency;
  const rows = await ingestion.db.transaction.findMany({
    where: {
      type: 'transfer',
      accountId: counter.id,
      toAccountId: account.id,
      toExternalId: null,
      date: createDateWindow(item.date),
      OR: [
        { toAmount: createRoundingRange(received) },
        { toAmount: null, amount: createRoundingRange(received) },
        ...(sameCurrency ? [] : [{ toAmount: 0 }]),
      ],
    },
  });
  const exact = rows.filter((row) => Math.abs(readCreditedAmount(row) - received) <= AMOUNT_TOLERANCE);
  const candidate = pickClosest(exact.length > 0 ? exact : rows, item.date);
  if (candidate !== undefined) {
    const settlesUnknownAmount = candidate.needsReview && candidate.reviewReason?.startsWith('Невідома сума зарахування') === true;
    await ingestion.db.transaction.update({
      where: { id: candidate.id },
      data: {
        toExternalId: externalId,
        ...(sameCurrency ? {} : { toAmount: received }),
        ...(settlesUnknownAmount ? { needsReview: false, reviewReason: null } : {}),
      },
    });
    ingestion.counts.updated += 1;
    return;
  }

  const sent = sameCurrency
    ? received
    : item.operationCurrency === counter.currency && item.operationAmount !== null
      ? Math.abs(item.operationAmount)
      : null;
  const draft: Draft =
    sent === null
      ? draftCategorised({
          item,
          account,
          category: FALLBACK_CATEGORY,
          reviewReason: `Переказ з «${counter.name}» без суми списання`,
        })
      : {
          type: 'transfer',
          accountId: counter.id,
          amount: sent,
          currency: counter.currency,
          toAccountId: account.id,
          toAmount: sameCurrency ? null : received,
          toCurrency: account.currency,
          category: null,
          reviewReason: null,
          authoritative: true,
        };
  await createRow({ ingestion, item, draft, externalId, incomingLeg: sent !== null });
};

/**
 * A split row keeps the amount its parts add up to; when the bank settles it differently, the
 * first part asks for a look instead of the balance drifting away from the bank's.
 */
const updateSyncedAmount = async ({ ingestion, existing, item }: { ingestion: Ingestion; existing: TransactionRow; item: StatementItem }) => {
  const amount = Math.abs(item.amount);
  const [part] = await ingestion.db.transaction.findMany({ where: { splitOfId: existing.id }, orderBy: { createdAt: 'asc' }, take: 1 });
  if (part === undefined) {
    await ingestion.db.transaction.update({ where: { id: existing.id }, data: { amount, raw: item.raw } });
    return;
  }
  await ingestion.db.transaction.update({ where: { id: existing.id }, data: { raw: item.raw } });
  if (Math.abs(toNumber(existing.amount) - amount) >= AMOUNT_TOLERANCE) {
    await ingestion.db.transaction.update({
      where: { id: part.id },
      data: {
        needsReview: true,
        reviewReason: `Банк змінив суму розділеного запису: було ${toNumber(existing.amount).toLocaleString('uk-UA')}, стало ${amount.toLocaleString('uk-UA')} ${existing.currency}. Розділи заново`,
      },
    });
  }
};

const ingestItem = async ({ ingestion, item }: { ingestion: Ingestion; item: StatementItem }) => {
  const account = requireAccount(ingestion, item.accountId);
  const externalId = prefixExternalId(ingestion.source, item.externalId);
  if (ingestion.dismissed.has(externalId)) return;
  // Zero-amount lines are card verifications, not money.
  if (item.amount === 0) return;

  const existing = await ingestion.db.transaction.findFirst({
    where: { OR: [{ externalId }, { toExternalId: externalId }] },
  });
  if (existing !== null) {
    // Holds settle under the same id, sometimes with a different amount. A row the owner entered
    // or merged keeps the amounts they chose (a gift booked gross while the bank shows it net).
    if (existing.externalId === externalId && existing.type !== 'transfer' && existing.source === ingestion.source) {
      await updateSyncedAmount({ ingestion, existing, item });
    }
    ingestion.counts.updated += 1;
    return;
  }

  const counter = findCounterAccount(ingestion, item);
  if (counter !== undefined && item.amount > 0) {
    await ingestOwnInflow({ ingestion, item, account, counter, externalId });
    return;
  }

  for (const [suffix, draft] of await draftItem({ ingestion, item, account })) {
    const lineId = `${externalId}${suffix}`;
    const incomingLeg = draft.type === 'transfer' && draft.toAccountId === account.id;
    // Matching looks at what arrived on this account, whichever side the transfer starts from.
    const seen = incomingLeg ? { ...draft, accountId: account.id, amount: item.amount } : draft;
    const findCandidate = item.amount < 0 ? findOutflowCandidate : findInflowCandidate;
    const candidate = suffix === '' ? await findCandidate({ ingestion, item, draft: seen }) : undefined;
    if (candidate === undefined) await createRow({ ingestion, item, draft, externalId: lineId, incomingLeg });
    else await claimRow({ ingestion, item, draft: seen, candidate, externalId: lineId });
  }
};

/**
 * Two banks book one move twice: Mono shows the card payment, Revolut a "Top-Up" income. When
 * a transfer into a synced account still lacks its incoming leg, it takes over such an income
 * line (same amount, a few days apart) and the income row goes away.
 */
export const linkStrayInflows = async (db: Db): Promise<number> => {
  const transfers = await db.transaction.findMany({
    where: { type: 'transfer', toExternalId: null, toAccount: { syncSource: { not: null } } },
  });
  let linked = 0;
  for (const transfer of transfers) {
    if (transfer.toAccountId === null) continue;
    const credited = readCreditedAmount(transfer);
    const date = toIsoDate(transfer.date);
    const strays = await db.transaction.findMany({
      where: {
        type: 'income',
        accountId: transfer.toAccountId,
        externalId: { not: null },
        source: { notIn: ADOPTABLE_SOURCES },
        OR: [{ needsReview: true }, { category: FALLBACK_CATEGORY }],
        splits: { none: {} },
        date: { gte: fromIsoDate(shiftDate(date, -STRAY_INFLOW_DAYS)), lte: fromIsoDate(shiftDate(date, STRAY_INFLOW_DAYS)) },
        ...(credited > 0 ? { amount: createAmountRange(credited) } : {}),
      },
    });
    const stray = pickClosest(strays, date);
    if (stray === undefined) continue;
    await db.$transaction([
      db.transaction.delete({ where: { id: stray.id } }),
      db.transaction.update({
        where: { id: transfer.id },
        data: {
          toExternalId: stray.externalId,
          ...(credited > 0 ? {} : { toAmount: stray.amount }),
          ...(transfer.reviewReason?.startsWith('Невідома сума зарахування') === true ? { needsReview: false, reviewReason: null } : {}),
        },
      }),
    ]);
    linked += 1;
  }
  return linked;
};

const isOwnInflow = (ingestion: Ingestion, item: StatementItem) =>
  item.amount > 0 && findCounterAccount(ingestion, item) !== undefined;

/**
 * Turns statement lines into ledger rows. Outflows go first so each incoming own-account leg
 * finds the transfer its outgoing leg created; lines already linked are skipped, so re-running
 * over overlapping windows is safe.
 */
export const ingestStatement = async ({
  db,
  source,
  items,
}: {
  db: Db;
  source: SyncSource;
  items: readonly StatementItem[];
}): Promise<SyncCounts> => {
  const [accounts, rules, dismissed] = await Promise.all([
    db.account.findMany(),
    db.rule.findMany(),
    db.dismissedLine.findMany({ where: { externalId: { startsWith: prefixExternalId(source, '') } } }),
  ]);
  const ingestion: Ingestion = {
    db,
    source,
    dismissed: new Set(dismissed.map((line) => line.externalId)),
    accounts: new Map(accounts.map((account) => [account.id, account])),
    accountsByIban: new Map(
      accounts.flatMap((account) => (account.iban === null ? [] : [[normalizeIban(account.iban), account] as const])),
    ),
    rules: rules.map(mapRule),
    counts: { fetched: items.length, created: 0, updated: 0 },
    created: [],
  };

  // Within a day, spending before refunds: a cancellation must find the purchase it reverses.
  const chronological = items.toSorted(
    (left, right) => left.date.localeCompare(right.date) || Math.sign(left.amount) - Math.sign(right.amount),
  );
  for (const item of chronological.filter((candidate) => !isOwnInflow(ingestion, candidate))) {
    await ingestItem({ ingestion, item });
  }
  for (const item of chronological.filter((candidate) => isOwnInflow(ingestion, candidate))) {
    await ingestItem({ ingestion, item });
  }
  for (const id of ingestion.created) await flagSuspectedDuplicate({ ingestion, id });
  ingestion.counts.updated += await linkStrayInflows(db);
  return ingestion.counts;
};
