import {
  classifyTransaction,
  convertToEur,
  createRuleMatcher,
  detectPayeeKind,
  findBankText,
  findPayeeText,
  indexCategoryUse,
  indexPayeeHistory,
  normalizeMerchant,
  rankCandidateCategories,
  suggestCategory,
  suggestRulePattern,
} from '@hroshi/domain';
import {
  type IsoDate,
  type PayeeKind,
  PayeeKindSchema,
  type ReviewGroup,
  type ReviewImpact,
  type ReviewKind,
  ReviewCountSchema,
  ReviewInboxSchema,
  SnoozedReviewSchema,
  SnoozeReviewSchema,
  type Transaction,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { type Ledger, loadLedger, toTransactionRow } from '../ledger.ts';
import { fromIsoDate, mapRule, toIsoDate } from '../mappers.ts';
import { listRuleSubjects } from '../rules/subjects.ts';

/** Bank wording that names no payee: a rule on it would catch unrelated rows. */
const GENERIC_TEXT = /розстрочк|щомісячний платіж|поповнення|погашення|переказ на картку|переказ між/iu;
/** A rule catching more than this is too broad to create without a look. */
const MAX_DEFAULT_RULE_HITS = 300;

/** The key of the bank's own spelling, which renames and the owner's answers are stored under. */
const findBankKey = (transaction: Transaction) => normalizeMerchant(findBankText(transaction)).key;

/**
 * The owner's word wins; a masked card stays a question until he answers it; own money, cash and
 * tax are recognised before bank wording, because Mono books them with the same generic texts.
 */
const findKind = ({ first, pattern, owner }: { first: Transaction; pattern: string; owner: PayeeKind | undefined }): ReviewKind => {
  if (owner !== undefined) return owner;
  if (findBankKey(first).startsWith('CARD ')) return 'card';
  const detected = detectPayeeKind({ text: findBankText(first), mcc: first.mcc });
  if (detected !== 'person' && detected !== 'merchant') return detected;
  return GENERIC_TEXT.test(pattern) ? 'generic' : detected;
};

const findGroupKey = (transaction: Transaction) => normalizeMerchant(findPayeeText(transaction)).key;

/** A group is parked only while every row in it is; the earliest wake-up day is the group's. */
const findSnoozedUntil = ({ rows, snoozed }: { rows: readonly Transaction[]; snoozed: ReadonlyMap<string, IsoDate> }): IsoDate | null => {
  const days = rows.map((row) => snoozed.get(row.id));
  if (days.some((day) => day === undefined)) return null;
  return days.reduce<IsoDate | null>((earliest, day) => (day === undefined || (earliest !== null && earliest <= day) ? earliest : day), null);
};

/** What the rows do to the numbers if nobody answers: the cost of leaving them, per effect. */
const describeImpact = ({ rows, ledger }: { rows: readonly Transaction[]; ledger: Ledger }): ReviewImpact[] => {
  const totals = new Map<string, ReviewImpact>();
  for (const row of rows) {
    const effect = classifyTransaction(row, ledger.policies);
    const eur = Math.abs(convertToEur({ transaction: row, fx: ledger.fx }) ?? 0);
    const category = effect.kind === 'spend' ? effect.category : null;
    const key = `${effect.kind}:${category ?? ''}`;
    const entry = totals.get(key) ?? { kind: effect.kind, category, eur: 0 };
    entry.eur += effect.kind === 'spend' ? effect.sign * eur : eur;
    totals.set(key, entry);
  }
  return [...totals.values()].toSorted((left, right) => Math.abs(right.eur) - Math.abs(left.eur));
};

/** The purchase each refund or cancellation in the group belongs to, by the refund's id. */
const findPurchases = ({ rows, ledger }: { rows: readonly Transaction[]; ledger: Ledger }): Map<string, Transaction> =>
  new Map(
    rows.flatMap((row) => {
      const chainId = ledger.chains.get(row.id);
      const purchase =
        chainId === undefined
          ? undefined
          : ledger.transactions.find(
              (candidate) => candidate.id !== row.id && candidate.type === 'expense' && ledger.chains.get(candidate.id) === chainId,
            );
      return purchase === undefined ? [] : [[row.id, purchase]];
    }),
  );

export const reviewRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Counted in the database: the badge is on every screen and must not load the ledger. */
  app.get('/review/count', { schema: { response: { 200: ReviewCountSchema } } }, async () => {
    const today = fromIsoDate(findToday());
    const [total, snoozed] = await Promise.all([
      prisma.transaction.count({ where: { needsReview: true, splits: { none: {} } } }),
      prisma.transaction.count({ where: { needsReview: true, splits: { none: {} }, snoozedUntil: { gt: today } } }),
    ]);
    return { waiting: total - snoozed, snoozed };
  });

  /** Rows waiting for the owner, grouped by payee so repeats get one answer, each with a suggested category. */
  app.get('/review', { schema: { response: { 200: ReviewInboxSchema } } }, async () => {
    const today = fromIsoDate(findToday());
    const [ledger, rules, aliases, parked] = await Promise.all([
      loadLedger(prisma),
      prisma.rule.findMany(),
      prisma.payeeAlias.findMany({ where: { kind: { not: null } } }),
      prisma.transaction.findMany({
        where: { needsReview: true, snoozedUntil: { gt: today } },
        select: { id: true, snoozedUntil: true },
      }),
    ]);
    const subjects = listRuleSubjects(ledger);
    const byId = new Map(ledger.transactions.map((transaction) => [transaction.id, transaction]));
    const history = indexPayeeHistory(ledger.transactions);
    const use = indexCategoryUse(ledger.transactions);
    const mappedRules = rules.map(mapRule);
    const ownerKinds = new Map(
      aliases.flatMap((alias) => {
        const kind = PayeeKindSchema.safeParse(alias.kind).data;
        return kind === undefined ? [] : [[alias.key, kind]];
      }),
    );
    const snoozed = new Map(parked.flatMap((row) => (row.snoozedUntil === null ? [] : [[row.id, toIsoDate(row.snoozedUntil)]])));
    const categories = new Map(ledger.categories.map((category) => [category.name, category]));
    const waiting = ledger.transactions.filter((transaction) => transaction.needsReview).toReversed();

    const groups = [...Map.groupBy(waiting, findGroupKey)].flatMap(([key, rows]): ReviewGroup[] => {
      const [first] = rows;
      if (first === undefined) return [];
      const categorised = rows.find((row) => row.type === 'expense' || row.type === 'income');
      // Rules match the bank line, so a renamed payee still gets a pattern from the bank's spelling.
      const pattern = suggestRulePattern(findBankText(first));
      const match = createRuleMatcher([
        { id: 'preview', pattern, mcc: null, accountId: null, category: null, transferToAccountId: null, priority: 0 },
      ]);
      const patternHits = pattern.trim().length < 2 ? 0 : subjects.filter((subject) => match(subject) !== undefined).length;
      const owner = ownerKinds.get(findBankKey(first)) ?? ownerKinds.get(key);
      const kind = findKind({ first, pattern, owner });
      const purchases = findPurchases({ rows, ledger });
      const suggestion =
        categorised === undefined ? null : suggestCategory({ transaction: categorised, history, rules: mappedRules, mcc: categorised.mcc });
      const direction = categorised?.type === 'income' ? 'forIncome' : 'forExpense';
      return [{
        key,
        name: normalizeMerchant(findPayeeText(first)).name,
        kind,
        kindByOwner: owner !== undefined,
        bankKeys: [...new Set(rows.map(findBankKey))],
        pattern,
        patternHits,
        ruleByDefault: (kind === 'merchant' || kind === 'tax') && patternHits <= MAX_DEFAULT_RULE_HITS,
        totalEur: rows.reduce((sum, row) => sum + Math.abs(convertToEur({ transaction: row, fx: ledger.fx }) ?? 0), 0),
        latestDate: rows.reduce((latest, row) => (row.date > latest ? row.date : latest), ''),
        pairs: Object.fromEntries([...purchases].map(([id, purchase]) => [id, toTransactionRow(ledger, purchase)])),
        rows: rows.map((row) => toTransactionRow(ledger, row)),
        suggestion,
        candidates:
          categorised === undefined || kind === 'card'
            ? []
            : rankCandidateCategories({
                transaction: categorised,
                kind: kind === 'generic' ? 'merchant' : kind,
                history,
                use,
                isAllowed: (name) => {
                  const category = categories.get(name);
                  return category !== undefined && !category.archived && category[direction] && name !== suggestion?.category;
                },
              }),
        snoozedUntil: findSnoozedUntil({ rows, snoozed }),
        twins: Object.fromEntries(
          rows.flatMap((row) => {
            const twin = row.duplicateOfId === null ? undefined : byId.get(row.duplicateOfId);
            return twin === undefined ? [] : [[row.id, toTransactionRow(ledger, twin)]];
          }),
        ),
        impact: describeImpact({ rows, ledger }),
        dependsOn: [
          ...new Set(
            [...purchases.values()]
              .filter((purchase) => purchase.needsReview)
              .map(findGroupKey)
              .filter((other) => other !== key),
          ),
        ],
      }];
    });

    return {
      total: waiting.length,
      snoozed: groups.reduce((sum, group) => sum + (group.snoozedUntil === null ? 0 : group.rows.length), 0),
      groups: groups.toSorted((left, right) => right.rows.length - left.rows.length),
    };
  });

  /** Parks rows that are still waiting; answered rows are left alone. */
  app.post(
    '/review/snooze',
    { schema: { body: SnoozeReviewSchema, response: { 200: SnoozedReviewSchema } } },
    async (request) => {
      const { ids, until } = request.body;
      const { count } = await prisma.transaction.updateMany({
        where: { id: { in: ids }, needsReview: true },
        data: { snoozedUntil: until === null ? null : fromIsoDate(until) },
      });
      return { updated: count };
    },
  );
};
