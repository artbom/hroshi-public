import type {
  AccountBalance,
  IsoDate,
  ReviewGroup,
  ReviewImpact,
  ReviewKind,
  RuleInput,
  SuggestionConfidence,
  TransactionRow,
} from '@hroshi/schema';

import { formatEurApprox } from '../format.ts';
import type { ReviewAnswer } from '../queries.ts';

/** What the owner has chosen for a group so far; nothing is saved until Enter or «Зберегти». */
export type Draft = {
  category: string;
  makeRule: boolean;
  pattern: string;
  /** Rows the answer should leave alone. */
  excluded: ReadonlySet<string>;
};

export const KIND_LABELS: Readonly<Record<ReviewKind, string>> = {
  merchant: 'магазин / сервіс',
  person: 'людина',
  own: 'свій переказ',
  cash: 'готівка',
  tax: 'податок',
  card: 'картка',
  generic: 'банківський запис',
};

/** Kinds that are money moving between the owner's own pockets: the answer is a transfer, not a category. */
export const TRANSFER_KINDS: ReadonlySet<ReviewKind> = new Set(['own', 'cash']);

/** One line under a group whose kind changes what the right answer is. */
export const describeKindHint = (kind: ReviewKind): string | null => {
  switch (kind) {
    case 'own':
      return 'Схоже на переказ між твоїми рахунками: запиши як переказ, тоді це не витрата й не дохід.';
    case 'cash':
      return 'Зняття готівки — переказ на рахунок «Готівка», не витрата.';
    case 'tax':
      return 'Податок або збір: правило для наступних увімкнене.';
    default:
      return null;
  }
};

export const CONFIDENCE_LABELS: Readonly<Record<SuggestionConfidence, string>> = {
  high: 'впевнено',
  medium: 'ймовірно',
  low: 'слабко',
};

export const createDraft = (group: ReviewGroup): Draft => ({
  category: group.suggestion?.category ?? '',
  makeRule: group.ruleByDefault,
  pattern: group.pattern,
  excluded: new Set(),
});

/** Rows a bank line duplicates get their own merge question, not the group's category. */
export const listPlainRows = (group: ReviewGroup): TransactionRow[] => group.rows.filter((row) => group.twins[row.id] === undefined);

export type Direction = 'income' | 'expense';

/** Whether the group's answer is an income category or a spending one: the first row a category applies to decides, as saving does. */
export const findDirection = (group: ReviewGroup): Direction =>
  listPlainRows(group).find((row) => row.type === 'income' || row.type === 'expense')?.type === 'income' ? 'income' : 'expense';

const sumEur = ({ group, type }: { group: ReviewGroup; type: TransactionRow['type'] }) =>
  group.rows.filter((row) => row.type === type).reduce((sum, row) => sum + Math.abs(row.eur ?? 0), 0);

/** «+1 318 € надходження», «−6 321 € витрата»: which way the group's money went, not just how much. */
export const describeGroupFlow = (group: ReviewGroup): string => {
  const income = sumEur({ group, type: 'income' });
  const expense = sumEur({ group, type: 'expense' });
  const moved = sumEur({ group, type: 'transfer' });
  const parts = [
    income > 0 ? `+${formatEurApprox(income)} надходження` : null,
    expense > 0 ? `−${formatEurApprox(expense)} витрата` : null,
    moved > 0 ? `${formatEurApprox(moved)} переказ` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? `≈ ${formatEurApprox(group.totalEur)}` : parts.join(' · ');
};

export const listCategorisable = ({ group, draft }: { group: ReviewGroup; draft: Draft }): TransactionRow[] =>
  listPlainRows(group).filter((row) => !draft.excluded.has(row.id) && (row.type === 'expense' || row.type === 'income'));

export const buildAnswer = ({ group, draft }: { group: ReviewGroup; draft: Draft }): ReviewAnswer | null => {
  const rows = listCategorisable({ group, draft });
  const [first] = rows;
  if (first === undefined || draft.category === '') return null;
  const pattern = draft.pattern.trim();
  const rule: RuleInput | null =
    draft.makeRule && pattern.length >= 2
      ? {
          pattern,
          mcc: null,
          accountId: null,
          category: draft.category,
          transferToAccountId: null,
          priority: 100,
          note: 'Створено з перевірки',
        }
      : null;
  return {
    ids: rows.map((row) => row.id),
    patch: { category: draft.category, type: first.type === 'income' ? 'income' : 'expense' },
    rule,
  };
};

/** A suggestion safe to take without opening the group: the payee's history agrees and nothing waits on another answer. */
export const isAcceptable = (group: ReviewGroup) =>
  group.snoozedUntil === null &&
  group.suggestion?.confidence === 'high' &&
  group.dependsOn.length === 0 &&
  listPlainRows(group).some((row) => row.type === 'expense' || row.type === 'income');

const describeEffect = ({ kind, category, eur }: ReviewImpact): string => {
  switch (kind) {
    case 'spend':
      return eur >= 0
        ? `рахується як витрата в «${category ?? 'Інше'}»: ${formatEurApprox(eur)}`
        : `зменшує витрати «${category ?? 'Інше'}» на ${formatEurApprox(-eur)}`;
    case 'income':
      return `рахується як дохід: ${formatEurApprox(eur)}`;
    case 'refund':
      return `зменшує загальні витрати на ${formatEurApprox(eur)}`;
    case 'none':
      return `не рахується ні в доходах, ні у витратах (${formatEurApprox(eur)})`;
  }
};

/** «Зараз рахується як витрата в «Інше»: 6 321 €»: what leaving the group unanswered costs the numbers. */
export const describeImpact = (impact: readonly ReviewImpact[]): string | null =>
  impact.length === 0 ? null : `Зараз ${impact.map(describeEffect).join('; ')}`;

/** Why a group has no rule ticked: the owner should know it was a choice, not an oversight. */
export const describeRuleDefault = (group: ReviewGroup): string | null => {
  if (group.ruleByDefault) return null;
  if (group.kind === 'person' || group.kind === 'card') return 'для людей і карток правило за замовчуванням вимкнене';
  if (TRANSFER_KINDS.has(group.kind)) return 'для своїх переказів правило з категорією не потрібне';
  if (group.kind === 'generic') return 'для банківських фраз без назви правило за замовчуванням вимкнене';
  return 'текст надто загальний, тож правило за замовчуванням вимкнене';
};

/** Groups whose answer another needs come right before it, whatever the chosen sort says. */
export const orderByDependencies = (groups: readonly ReviewGroup[]): ReviewGroup[] => {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const placed = new Set<string>();
  const ordered: ReviewGroup[] = [];
  const place = (group: ReviewGroup) => {
    if (placed.has(group.key)) return;
    placed.add(group.key);
    for (const key of group.dependsOn) {
      const prerequisite = byKey.get(key);
      if (prerequisite !== undefined) place(prerequisite);
    }
    ordered.push(group);
  };
  for (const group of groups) place(group);
  return ordered;
};

/**
 * «Це твоя картка?» → yes: the rows become transfers to that account and a rule books the next ones
 * the same way. Money that came from the card is booked the other way round, and only when the
 * currencies match, since the amount the card sent is not known otherwise.
 */
export const buildOwnCardAnswers = ({ group, account }: { group: ReviewGroup; account: AccountBalance }): ReviewAnswer[] => {
  const rows = listPlainRows(group);
  const sent = rows.filter((row) => row.type === 'expense' && row.accountId !== account.id);
  const received = rows.filter((row) => row.type === 'income' && row.accountId !== account.id && row.currency === account.currency);
  const [first] = sent;
  const rule: RuleInput = {
    pattern: group.pattern,
    mcc: null,
    accountId: null,
    category: null,
    transferToAccountId: account.id,
    priority: 100,
    note: 'Своя картка, з перевірки',
  };
  const toCard: ReviewAnswer[] =
    first === undefined
      ? []
      : [
          {
            ids: sent.map((row) => row.id),
            patch: { type: 'transfer', toAccountId: account.id, toAmount: first.currency === account.currency ? null : 0 },
            rule: null,
          },
        ];
  const fromCard = received.map(
    (row): ReviewAnswer => ({
      ids: [row.id],
      patch: { type: 'transfer', accountId: account.id, toAccountId: row.accountId, toAmount: null },
      rule: null,
    }),
  );
  const moves = [...toCard, ...fromCard];
  return moves.map((move, index) => (index === moves.length - 1 ? { ...move, rule } : move));
};

/** A day this many days after another, in the same «2026-11-11» form the API takes. */
export const shiftDay = ({ day, days }: { day: IsoDate; days: number }): IsoDate => {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
