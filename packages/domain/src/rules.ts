import type { RuleIssue } from '@hroshi/schema';

import type { MatchableRule } from './types.ts';

export type RuleSubject = {
  accountId: string;
  mcc: number | null;
  /** Every text field the provider gives (description, counterparty, comment). */
  texts: readonly (string | null | undefined)[];
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Banks and the owner type «mcdonald's» with any of these; a rule should not care which. */
const APOSTROPHES = /['’‘ʼ`´]/gu;
const APOSTROPHE_CLASS = "['’‘ʼ`´]";

const boundaryFor = (character: string | undefined, side: 'before' | 'after') => {
  const look = side === 'before' ? '?<!' : '?!';
  if (character !== undefined && /\p{L}/u.test(character)) return `(${look}\\p{L})`;
  if (character !== undefined && /\p{N}/u.test(character)) return `(${look}\\p{N})`;
  return '';
};

/**
 * A pattern must not continue into a longer word of the same kind: "lime" matches
 * "LIME*RIDE" but not "ALIMENTACIO", "365" matches "365 T196" but not a phone number.
 */
export const compileRulePattern = (pattern: string): RegExp =>
  new RegExp(
    `${boundaryFor(pattern.at(0), 'before')}${escapeRegExp(pattern).replace(APOSTROPHES, APOSTROPHE_CLASS)}${boundaryFor(pattern.at(-1), 'after')}`,
    'iu',
  );

/** First rule by priority whose every set condition holds. */
export const findMatchingRule = <TRule extends MatchableRule>(
  rules: readonly TRule[],
  subject: RuleSubject,
): TRule | undefined => {
  const haystack = subject.texts.filter(Boolean).join(' \n ');
  return rules
    .toSorted((left, right) => left.priority - right.priority)
    .find(
      (rule) =>
        (rule.accountId === null || rule.accountId === subject.accountId) &&
        (rule.mcc === null || rule.mcc === subject.mcc) &&
        (rule.pattern === null || compileRulePattern(rule.pattern).test(haystack)),
    );
};

/** Rules sorted and compiled once, for matching thousands of rows. */
export const createRuleMatcher = <TRule extends MatchableRule>(rules: readonly TRule[]) => {
  const compiled = rules
    .toSorted((left, right) => left.priority - right.priority)
    .map((rule) => ({ rule, pattern: rule.pattern === null ? null : compileRulePattern(rule.pattern) }));
  return (subject: RuleSubject): TRule | undefined => {
    const haystack = subject.texts.filter(Boolean).join(' \n ');
    return compiled.find(
      ({ rule, pattern }) =>
        (rule.accountId === null || rule.accountId === subject.accountId) &&
        (rule.mcc === null || rule.mcc === subject.mcc) &&
        (pattern === null || pattern.test(haystack)),
    )?.rule;
  };
};

const normalizePattern = (pattern: string | null) =>
  pattern?.toLocaleLowerCase('uk').replace(APOSTROPHES, "'").replace(/\s+/gu, ' ').trim() ?? '';

const keyOf = (rule: MatchableRule) => `${normalizePattern(rule.pattern)}|${rule.mcc ?? ''}|${rule.accountId ?? ''}`;

export type RuleAudit = { hits: number; lastMatch: string | null; issues: RuleIssue[]; relatedId: string | null; categories: number };

/** Below this many characters a pattern catches too much («банку», «поповнення «»). */
const BROAD_PATTERN_LENGTH = 6;
/** A rule whose matches the owner booked into this many categories is guessing. */
const BROAD_CATEGORY_SPREAD = 3;

/**
 * What each rule does on the history: how many rows it is the first match for, when it last
 * matched, and whether it repeats another rule, can never win against one, is so broad that the
 * owner books its matches into several categories, never matched at all, or books into something
 * archived. MCC-only rules are seeded fallbacks for future purchases, so a silent one is no issue.
 */
export const auditRules = <TRule extends MatchableRule>({
  rules,
  rows,
  archivedCategories = new Set(),
  archivedAccounts = new Set(),
}: {
  rules: readonly TRule[];
  rows: readonly (RuleSubject & { date: string; category: string | null })[];
  archivedCategories?: ReadonlySet<string>;
  archivedAccounts?: ReadonlySet<string>;
}): Map<string, RuleAudit> => {
  const match = createRuleMatcher(rules);
  const hits = new Map<string, { count: number; last: string | null; categories: Set<string> }>();
  for (const row of rows) {
    const rule = match(row);
    if (rule === undefined) continue;
    const entry = hits.get(rule.id) ?? { count: 0, last: null, categories: new Set<string>() };
    hits.set(rule.id, entry);
    entry.count += 1;
    if (entry.last === null || row.date > entry.last) entry.last = row.date;
    if (row.category !== null) entry.categories.add(row.category);
  }

  const seen = Map.groupBy(rules, keyOf);
  return new Map(
    rules.map((rule) => {
      const entry = hits.get(rule.id);
      const issues: RuleIssue[] = [];
      const twin = seen.get(keyOf(rule))?.find((other) => other.id !== rule.id);
      if (twin !== undefined) issues.push('duplicate');
      const pattern = rule.pattern;
      const shadowedBy =
        pattern === null
          ? undefined
          : rules.find(
              (other) =>
                other.id !== rule.id &&
                other.pattern !== null &&
                other.pattern.length < pattern.length &&
                other.priority <= rule.priority &&
                (other.accountId === null || other.accountId === rule.accountId) &&
                (other.mcc === null || other.mcc === rule.mcc) &&
                compileRulePattern(other.pattern).test(pattern),
            );
      if (shadowedBy !== undefined) issues.push('shadowed');
      const spread = entry?.categories.size ?? 0;
      const short = pattern !== null && pattern.trim().length < BROAD_PATTERN_LENGTH;
      if ((short && spread >= BROAD_CATEGORY_SPREAD) || spread >= BROAD_CATEGORY_SPREAD * 2) issues.push('broad');
      if (entry === undefined && pattern !== null) issues.push('unused');
      if (
        (rule.category !== null && archivedCategories.has(rule.category)) ||
        (rule.transferToAccountId !== null && archivedAccounts.has(rule.transferToAccountId))
      ) {
        issues.push('archived');
      }
      return [
        rule.id,
        {
          hits: entry?.count ?? 0,
          lastMatch: entry?.last ?? null,
          issues,
          relatedId: twin?.id ?? shadowedBy?.id ?? null,
          categories: spread,
        },
      ];
    }),
  );
};
