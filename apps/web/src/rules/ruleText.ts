import type { Rule, RuleIssue, RuleStats } from '@hroshi/schema';

import { formatDay, pluralize } from '../format.ts';

export type RuleStat = RuleStats[number];

/** Seeded MCC fallbacks sit at this priority and above; they are many and rarely edited. */
export const MCC_FALLBACK_PRIORITY = 1000;

/** «mcdonald's» + MCC 5814: what a rule looks for. */
export const describeRuleCondition = (rule: Rule): string =>
  [rule.pattern === null ? null : `«${rule.pattern}»`, rule.mcc === null ? null : `MCC ${rule.mcc}`]
    .filter((part) => part !== null)
    .join(' + ');

/** Where a match goes: a category, or a transfer to one of the owner's accounts. */
export const describeRuleTarget = ({ rule, names }: { rule: Rule; names: ReadonlyMap<string, string> }): string =>
  rule.category ?? `переказ → ${names.get(rule.transferToAccountId ?? '') ?? rule.transferToAccountId ?? '?'}`;

export const describeHits = (stat: RuleStat | undefined): string => {
  if (stat === undefined) return '';
  if (stat.hits === 0) return 'жодного збігу в історії';
  return `${pluralize(stat.hits, ['збіг', 'збіги', 'збігів'])}, востаннє ${formatDay(stat.lastMatch ?? '')}`;
};

export const ISSUE_LABELS: Readonly<Record<RuleIssue, string>> = {
  duplicate: 'дубль',
  shadowed: 'не спрацьовує',
  archived: 'веде в архів',
  unused: 'жодного збігу',
  broad: 'надто загальне',
};

/** The order issues are listed in: what breaks booking first, what is only noise last. */
export const ISSUE_ORDER: readonly RuleIssue[] = ['duplicate', 'shadowed', 'archived', 'unused', 'broad'];

const SEVERE: ReadonlySet<RuleIssue> = new Set(['duplicate', 'shadowed', 'archived']);

export const findIssueTone = (issues: readonly RuleIssue[]): 'bad' | 'warn' | null => {
  if (issues.some((issue) => SEVERE.has(issue))) return 'bad';
  return issues.length > 0 ? 'warn' : null;
};

/** One sentence per issue: what is wrong and what to do about it. */
export const adviseOnIssue = ({
  issue,
  rule,
  stat,
  related,
}: {
  issue: RuleIssue;
  rule: Rule;
  stat: RuleStat;
  related: Rule | undefined;
}): string => {
  const other = related === undefined ? 'інше правило' : describeRuleCondition(related);
  // «mcdonald's» and «mcdonald’s» look identical on screen; say what tells them apart.
  const spelling = related !== undefined && related.pattern !== rule.pattern ? ' (інший апостроф чи регістр)' : '';
  switch (issue) {
    case 'duplicate':
      return stat.hits === 0
        ? `Та сама умова, що й у ${other}${spelling}, і всі збіги дістаються йому — це правило можна видалити.`
        : `Та сама умова, що й у ${other}${spelling}: залиш одне правило, друге видали.`;
    case 'shadowed':
      return `Коротше ${other} з пріоритетом ${related?.priority ?? '?'} ловить ці записи першим: дай цьому правилу менший пріоритет або видали його.`;
    case 'archived':
      return rule.category === null
        ? 'Переказує на архівний рахунок: вибери інший рахунок або видали правило.'
        : `Записує в архівну категорію «${rule.category}»: вибери іншу або поверни категорію з архіву.`;
    case 'unused':
      return 'Жодного збігу в історії: перевір написання або видали, якщо такого продавця вже немає.';
    case 'broad':
      return `Збіги записані в ${pluralize(stat.categories, ['категорію', 'категорії', 'категорій'])}: уточни текст, обмеж рахунком чи MCC.`;
  }
};
