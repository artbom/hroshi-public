import type { BridgeFxPart, BridgeOtherPart, BridgeValuationPart, Currency, IsoDate, NetWorth, NetWorthBridge } from '@hroshi/schema';

import { listBalanceEffects } from './balances.ts';
import { type CategoryPolicies, classifyTransaction, FALLBACK_CATEGORY } from './classify.ts';
import { convertToEur, type FxConverter } from './fx.ts';
import { computeBalanceHistory } from './history.ts';
import type { LedgerAccount, LedgerTransaction } from './types.ts';

/** Credit-card debt is deliberate (owing hryvnia while it depreciates), so it is a bucket, not a warning. */
export const summarizeNetWorth = ({
  accounts,
  balances,
  fx,
  date,
}: {
  accounts: readonly LedgerAccount[];
  balances: ReadonlyMap<LedgerAccount['id'], number>;
  fx: FxConverter;
  date: IsoDate;
}): NetWorth => {
  const worth: NetWorth = {
    totalEur: 0,
    cashEur: 0,
    investmentsEur: 0,
    owedToMeEur: 0,
    creditDebtEur: 0,
    iOweEur: 0,
  };

  for (const account of accounts) {
    const eur = fx.toEur(balances.get(account.id) ?? 0, account.currency, date);
    if (eur === null) continue;
    if (account.kind === 'investment') worth.investmentsEur += eur;
    else if (account.kind === 'receivable') {
      if (eur >= 0) worth.owedToMeEur += eur;
      else worth.iOweEur += eur;
    } else if (eur < 0) worth.creditDebtEur += eur;
    else worth.cashEur += eur;
    worth.totalEur += eur;
  }

  return worth;
};

/** A value a broker's statement gives for a day, in the account's currency. */
export type DatedValue = { date: IsoDate; value: number };

/**
 * What a broker's statement knows about one tracker account: its value on the days it reports
 * (oldest first) and the deposits (+) and withdrawals (−) it lists, both in the account's currency.
 */
export type BrokerSeries = {
  accountId: LedgerAccount['id'];
  values: readonly DatedValue[];
  deposits: readonly DatedValue[];
};

/** Daily statements skip weekends and holidays; a longer silence leaves the value in between unknown. */
const MAX_VALUE_GAP_DAYS = 7;
const DAY_MS = 86_400_000;

const countDays = (from: IsoDate, to: IsoDate) => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;

/**
 * The broker's value on a day, or null where its statement does not know it. Before the first
 * point it is known only when that point is zero (the account was still empty); between two
 * points only when they are close, as in a daily NAV.
 */
export const findBrokerValue = ({ values, date }: { values: readonly DatedValue[]; date: IsoDate }): number | null => {
  const [first] = values;
  if (first === undefined) return null;
  if (date < first.date) return first.value === 0 ? 0 : null;
  const index = values.findLastIndex((point) => point.date <= date);
  const point = values[index];
  if (point === undefined) return null;
  if (point.date === date) return point.value;
  return countDays(point.date, values[index + 1]?.date ?? date) <= MAX_VALUE_GAP_DAYS ? point.value : null;
};

/**
 * From its opening on the ledger is exact. Before it, it walks back from the opening and misses
 * whatever the tracker never saw (deposits booked as spending, the market's growth), so a
 * statement that knows the value on that day wins.
 */
const findStatedBalance = ({ account, series, date }: { account: LedgerAccount; series: BrokerSeries | undefined; date: IsoDate }) =>
  series === undefined || date >= account.openingDate ? null : findBrokerValue({ values: series.values, date });

type Balances = Map<LedgerAccount['id'], number[]>;

const pickBalances = ({ accounts, balances, index }: { accounts: readonly LedgerAccount[]; balances: Balances; index: number }) =>
  new Map(accounts.map((account) => [account.id, balances.get(account.id)?.[index] ?? 0]));

/** Balances on each date: the ledger's, and a broker's own figure where its statement knows the day. */
const traceBalances = ({
  accounts,
  transactions,
  dates,
  brokers,
}: {
  accounts: readonly LedgerAccount[];
  transactions: readonly LedgerTransaction[];
  dates: readonly IsoDate[];
  brokers: readonly BrokerSeries[];
}): Balances => {
  const history = computeBalanceHistory({ accounts, transactions, dates });
  const series = new Map(brokers.map((entry) => [entry.accountId, entry]));
  return new Map(
    accounts.map((account) => [
      account.id,
      dates.map(
        (date, index) =>
          findStatedBalance({ account, series: series.get(account.id), date }) ?? history.get(account.id)?.[index] ?? 0,
      ),
    ]),
  );
};

/** Net worth on each date, from balances back-cast through the history rows, or a broker's statement where it knows better. */
export const traceNetWorth = ({
  accounts,
  transactions,
  fx,
  dates,
  brokers = [],
}: {
  accounts: readonly LedgerAccount[];
  transactions: readonly LedgerTransaction[];
  fx: FxConverter;
  dates: readonly IsoDate[];
  brokers?: readonly BrokerSeries[];
}): NetWorth[] => {
  const balances = traceBalances({ accounts, transactions, dates, brokers });
  return dates.map((date, index) => summarizeNetWorth({ accounts, balances: pickBalances({ accounts, balances, index }), fx, date }));
};

/** Parts of «Інше» smaller than this are rounding, not something to read. */
const MIN_PART_EUR = 0.5;

type BridgeFigures = Omit<NetWorthBridge, 'month' | 'fromMonth' | 'from' | 'to'>;

/** The rate effect per currency: what the balances held at `from` gained or lost in euros by `to`. */
const splitFxEffect = ({
  accounts,
  balances,
  fx,
  from,
  to,
}: {
  accounts: readonly LedgerAccount[];
  balances: ReadonlyMap<LedgerAccount['id'], number>;
  fx: FxConverter;
  from: IsoDate;
  to: IsoDate;
}): BridgeFxPart[] => {
  const byCurrency = new Map<Currency, BridgeFxPart>();
  for (const account of accounts) {
    const balance = balances.get(account.id) ?? 0;
    const before = fx.toEur(balance, account.currency, from);
    const after = fx.toEur(balance, account.currency, to);
    if (before === null || after === null) continue;
    const part = byCurrency.get(account.currency) ?? { currency: account.currency, balance: 0, eur: 0 };
    byCurrency.set(account.currency, { ...part, balance: part.balance + balance, eur: part.eur + after - before });
  }
  return [...byCurrency.values()]
    .filter((part) => Math.abs(part.eur) >= MIN_PART_EUR)
    .toSorted((left, right) => Math.abs(right.eur) - Math.abs(left.eur));
};

/** What one broker's statement changes in the bridge, in the account's currency. */
type BrokerReading = {
  account: LedgerAccount;
  /** Both ends are known (stated, or exact from the opening on), so the market's move comes from the statement. */
  covered: boolean;
  /** The statement's first deposit, when the account came alive; its first value without one. */
  opened: IsoDate | null;
  ledgerFrom: number;
  ledgerTo: number;
  statedFrom: number | null;
  statedTo: number | null;
  /** Deposits minus withdrawals the statement lists inside the period. */
  brokerNet: number;
  brokerRows: number;
};

const readBrokers = ({
  accounts,
  brokers,
  ledger,
  from,
  to,
}: {
  accounts: readonly LedgerAccount[];
  brokers: readonly BrokerSeries[];
  ledger: Balances;
  from: IsoDate;
  to: IsoDate;
}): BrokerReading[] =>
  brokers.flatMap((series) => {
    const account = accounts.find((candidate) => candidate.id === series.accountId);
    if (account === undefined) return [];
    const statedFrom = findStatedBalance({ account, series, date: from });
    const statedTo = findStatedBalance({ account, series, date: to });
    const inside = series.deposits.filter((deposit) => deposit.date > from && deposit.date <= to);
    return [
      {
        account,
        covered: statedFrom !== null && (statedTo !== null || to >= account.openingDate),
        opened: series.deposits.find((deposit) => deposit.value > 0)?.date ?? series.values[0]?.date ?? null,
        ledgerFrom: ledger.get(account.id)?.[0] ?? 0,
        ledgerTo: ledger.get(account.id)?.[1] ?? 0,
        statedFrom,
        statedTo,
        brokerNet: inside.reduce((sum, deposit) => sum + deposit.value, 0),
        brokerRows: inside.length,
      },
    ];
  });

/** Per account, what its own rows moved inside the period: transfer legs, and income or spending booked on it. */
type AccountMoves = { transfers: number; rows: number };

/**
 * Splits a net-worth change into what the owner saved, what markets did, what exchange rates
 * did to the same balances, and the rest, so the movement adds up to the figure shown. The rest
 * is itemised too: rows that move money without counting as spending or earnings, transfer
 * spreads, and the rate moving on money that arrived or left inside the period (the end
 * balance is valued at the end rate, the rows at their own day's rate).
 *
 * Where a broker's statement knows an account's value at both ends, the market's move is the
 * statement's (value change minus the deposits it lists) instead of the valuation rows, and the
 * deposits the tracker never saw as transfers get their own line in «Інше».
 */
export const bridgeNetWorth = ({
  accounts,
  transactions,
  fx,
  policies,
  from,
  to,
  brokers = [],
}: {
  accounts: readonly LedgerAccount[];
  transactions: readonly LedgerTransaction[];
  fx: FxConverter;
  policies: CategoryPolicies;
  from: IsoDate;
  to: IsoDate;
  brokers?: readonly BrokerSeries[];
}): BridgeFigures => {
  const dates = [from, to];
  const ledger = computeBalanceHistory({ accounts, transactions, dates });
  const balances = traceBalances({ accounts, transactions, dates, brokers });
  const start = summarizeNetWorth({ accounts, balances: pickBalances({ accounts, balances, index: 0 }), fx, date: from });
  const end = summarizeNetWorth({ accounts, balances: pickBalances({ accounts, balances, index: 1 }), fx, date: to });
  const readings = readBrokers({ accounts, brokers, ledger, from, to });
  const covered = new Set(readings.filter((reading) => reading.covered).map((reading) => reading.account.id));
  const currencies = new Map(accounts.map((account) => [account.id, account.currency]));
  const valueEffects = (transaction: LedgerTransaction, date: IsoDate) =>
    listBalanceEffects(transaction).reduce((sum, { accountId, delta }) => {
      const currency = currencies.get(accountId);
      return currency === undefined ? sum : sum + (fx.toEur(delta, currency, date) ?? 0);
    }, 0);

  let earnedEur = 0;
  let spentEur = 0;
  const valuationRows = new Map<string, { eur: number; first: IsoDate }>();
  const moves = new Map<string, AccountMoves>();
  const outside = new Map<string, BridgeOtherPart>();
  const transfers: BridgeOtherPart = { kind: 'transfers', category: null, accountId: null, eur: 0, rows: 0 };
  const rates: BridgeOtherPart = { kind: 'rates', category: null, accountId: null, eur: 0, rows: 0 };

  for (const transaction of transactions) {
    if (transaction.date <= from || transaction.date > to) continue;
    for (const { accountId, delta } of listBalanceEffects(transaction)) {
      if (!covered.has(accountId) || transaction.type === 'valuation') continue;
      const move = moves.get(accountId) ?? { transfers: 0, rows: 0 };
      moves.set(accountId, transaction.type === 'transfer' ? { ...move, transfers: move.transfers + delta } : { ...move, rows: move.rows + delta });
    }
    // The statement's figure replaces these rows, rate drift included.
    if (transaction.type === 'valuation' && covered.has(transaction.accountId)) continue;
    const atDate = valueEffects(transaction, transaction.date);
    const rateMove = valueEffects(transaction, to) - atDate;
    if (Math.abs(rateMove) >= 0.005) {
      rates.eur += rateMove;
      rates.rows += 1;
    }
    const eur = convertToEur({ transaction, fx }) ?? 0;
    if (transaction.type === 'valuation') {
      const entry = valuationRows.get(transaction.accountId) ?? { eur: 0, first: transaction.date };
      valuationRows.set(transaction.accountId, {
        eur: entry.eur + eur,
        first: transaction.date < entry.first ? transaction.date : entry.first,
      });
      continue;
    }
    if (transaction.type === 'transfer') {
      if (Math.abs(atDate) >= 0.005) {
        transfers.eur += atDate;
        transfers.rows += 1;
      }
      continue;
    }
    const effect = classifyTransaction(transaction, policies);
    if (effect.kind === 'income') earnedEur += eur;
    else if (effect.kind === 'refund') spentEur -= eur;
    else if (effect.kind === 'spend') spentEur += effect.sign * eur;
    else {
      const kind = transaction.type === 'income' ? 'income' : 'spending';
      const category = transaction.category ?? FALLBACK_CATEGORY;
      const key = `${kind}:${category}`;
      const part = outside.get(key) ?? { kind, category, accountId: null, eur: 0, rows: 0 };
      outside.set(key, { ...part, eur: part.eur + (kind === 'income' ? eur : -eur), rows: part.rows + 1 });
    }
  }

  const atEnd = (amount: number, account: LedgerAccount) => fx.toEur(amount, account.currency, to) ?? 0;
  const brokerValuations = readings.flatMap((reading): BridgeValuationPart[] => {
    if (!reading.covered || reading.statedFrom === null) return [];
    const move = moves.get(reading.account.id) ?? { transfers: 0, rows: 0 };
    const valueTo = reading.statedTo ?? reading.ledgerTo;
    const market = valueTo - reading.statedFrom - reading.brokerNet - move.rows;
    return [{ accountId: reading.account.id, source: 'broker', firstDate: reading.opened, eur: atEnd(market, reading.account) }];
  });
  const rowValuations = [...valuationRows].map(
    ([accountId, entry]): BridgeValuationPart => ({ accountId, source: 'rows', firstDate: entry.first, eur: entry.eur }),
  );
  const valuationParts = [...brokerValuations, ...rowValuations]
    .filter((part) => Math.abs(part.eur) >= MIN_PART_EUR)
    .toSorted((left, right) => Math.abs(right.eur) - Math.abs(left.eur));
  const valuationsEur = [...brokerValuations, ...rowValuations].reduce((sum, part) => sum + part.eur, 0);
  // Covered: deposits the statement lists that the tracker has no transfer for. Otherwise: the
  // statement's value standing in for the tracker's walk back from the opening at one end.
  const brokerParts = readings.map((reading): BridgeOtherPart => {
    const move = moves.get(reading.account.id) ?? { transfers: 0, rows: 0 };
    const amount = reading.covered
      ? reading.brokerNet - move.transfers
      : (reading.statedFrom === null ? 0 : reading.ledgerFrom - reading.statedFrom) +
        (reading.statedTo === null ? 0 : reading.statedTo - reading.ledgerTo);
    return { kind: 'brokers', category: null, accountId: reading.account.id, eur: atEnd(amount, reading.account), rows: reading.brokerRows };
  });

  const fxParts = splitFxEffect({ accounts, balances: pickBalances({ accounts, balances, index: 0 }), fx, from, to });
  const fxEur = fxParts.reduce((sum, part) => sum + part.eur, 0);
  const startEur = start.totalEur;
  const endEur = end.totalEur;
  const savingsEur = earnedEur - spentEur;
  const otherEur = endEur - startEur - savingsEur - valuationsEur - fxEur;
  const itemised = [...outside.values(), ...brokerParts, transfers, rates];
  const restEur = otherEur - itemised.reduce((sum, part) => sum + part.eur, 0);
  const rest: BridgeOtherPart = { kind: 'rest', category: null, accountId: null, eur: restEur, rows: 0 };
  return {
    startEur,
    endEur,
    savingsEur,
    earnedEur,
    spentEur,
    valuationsEur,
    valuationParts,
    fxEur,
    fxParts,
    otherEur,
    otherParts: [...itemised, rest]
      .filter((part) => Math.abs(part.eur) >= MIN_PART_EUR)
      .toSorted((left, right) => Math.abs(right.eur) - Math.abs(left.eur)),
    creditDebtChangeEur: end.creditDebtEur - start.creditDebtEur,
  };
};
