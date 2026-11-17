import type { Category, Rule } from '@hroshi/schema';
import { useState } from 'react';

import { describeError } from '../api.ts';
import { formatCategoryLabel } from '../components/categoryTree.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { formatAccountName, formatWhole, pluralize } from '../format.ts';
import { useAccounts, useCategories, useRules, useRuleStats } from '../queries.ts';
import { buildHref } from '../route.ts';
import { RuleSheet } from './RuleSheet.tsx';
import {
  adviseOnIssue,
  describeHits,
  describeRuleCondition,
  describeRuleTarget,
  findIssueTone,
  ISSUE_LABELS,
  ISSUE_ORDER,
  MCC_FALLBACK_PRIORITY,
  type RuleStat,
} from './ruleText.ts';

type Stats = ReadonlyMap<string, RuleStat>;

/** A sheet for a saved rule, a blank one for a new rule, or none. */
type OpenSheet = { kind: 'rule'; id: string } | { kind: 'new' } | null;

const matchesSearch = ({ rule, search, names }: { rule: Rule; search: string; names: ReadonlyMap<string, string> }) =>
  search === '' ||
  [rule.pattern, rule.mcc === null ? null : String(rule.mcc), rule.category, rule.note, names.get(rule.transferToAccountId ?? '')]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('uk')
    .includes(search.toLocaleLowerCase('uk'));

const groupByTarget = ({
  rules,
  names,
  categories,
}: {
  rules: readonly Rule[];
  names: ReadonlyMap<string, string>;
  categories: ReadonlyMap<string, Category>;
}) =>
  [
    ...Map.groupBy(rules, (rule) => {
      const category = rule.category === null ? undefined : categories.get(rule.category);
      return category === undefined ? describeRuleTarget({ rule, names }) : formatCategoryLabel(category);
    }),
  ].toSorted(([left], [right]) => left.localeCompare(right, 'uk'));

/** A rule as one tappable chip: the text it looks for and how many rows it booked. */
const RuleChip = ({
  rule,
  stat,
  names,
  selected,
  onOpen,
}: {
  rule: Rule;
  stat: RuleStat | undefined;
  names: ReadonlyMap<string, string>;
  selected: boolean;
  onOpen: (id: string) => void;
}) => {
  const tone = findIssueTone(stat?.issues ?? []);
  const label = rule.pattern ?? `MCC ${rule.mcc ?? '?'}`;
  return (
    <button
      type="button"
      className={['rule-chip', tone ?? '', selected ? 'sel' : ''].filter(Boolean).join(' ')}
      title={[describeHits(stat), `пріоритет ${rule.priority}`, rule.note].filter(Boolean).join(' · ')}
      onClick={() => onOpen(rule.id)}
    >
      <span className="t">{label}</span>
      {rule.pattern !== null && rule.mcc !== null && <span className="x">MCC {rule.mcc}</span>}
      {rule.accountId !== null && <span className="x">{names.get(rule.accountId) ?? rule.accountId}</span>}
      <span className="n num">{stat === undefined ? '' : formatWhole(stat.hits)}</span>
    </button>
  );
};

const RuleGroups = ({
  rules,
  stats,
  names,
  categories,
  openId,
  onOpen,
}: {
  rules: readonly Rule[];
  stats: Stats;
  names: ReadonlyMap<string, string>;
  categories: ReadonlyMap<string, Category>;
  openId: string | null;
  onOpen: (id: string) => void;
}) => (
  <div className="rule-groups">
    {groupByTarget({ rules, names, categories }).map(([target, group]) => (
      <div key={target} className="rule-group">
        <div className="rule-group-name">
          {target} <span className="muted small">{group.length}</span>
        </div>
        <div className="rule-chips">
          {group.map((rule) => (
            <RuleChip key={rule.id} rule={rule} stat={stats.get(rule.id)} names={names} selected={rule.id === openId} onOpen={onOpen} />
          ))}
        </div>
      </div>
    ))}
  </div>
);

/** Every rule with an issue, worst first, each with what to do about it. */
const AttentionList = ({
  flagged,
  rules,
  stats,
  names,
  onOpen,
}: {
  flagged: readonly Rule[];
  rules: ReadonlyMap<string, Rule>;
  stats: Stats;
  names: ReadonlyMap<string, string>;
  onOpen: (id: string) => void;
}) => (
  <section>
    <h2>Потребують уваги ({flagged.length})</h2>
    <div className="card list rule-attention">
      {flagged.map((rule) => {
        const stat = stats.get(rule.id);
        if (stat === undefined) return null;
        const issues = ISSUE_ORDER.filter((issue) => stat.issues.includes(issue));
        const first = issues[0];
        const related = stat.relatedId === null ? undefined : rules.get(stat.relatedId);
        const tone = findIssueTone(issues) ?? 'warn';
        return (
          <button key={rule.id} type="button" className="row" onClick={() => onOpen(rule.id)}>
            <span>
              <b>{describeRuleCondition(rule)}</b> <span className="muted">→ {describeRuleTarget({ rule, names })}</span>{' '}
              {issues.map((issue) => (
                <span key={issue} className={`chip ${tone}`}>
                  {ISSUE_LABELS[issue]}
                </span>
              ))}
            </span>
            <span className="r num muted">{pluralize(stat.hits, ['збіг', 'збіги', 'збігів'])}</span>
            {first !== undefined && <span className="s">{adviseOnIssue({ issue: first, rule, stat, related })}</span>}
          </button>
        );
      })}
    </div>
  </section>
);

const ruleSeverity = (stat: RuleStat | undefined) => {
  const first = ISSUE_ORDER.findIndex((issue) => stat?.issues.includes(issue) === true);
  return first === -1 ? ISSUE_ORDER.length : first;
};

export const RulesView = ({ highlight }: { highlight: string | null }) => {
  const rules = useRules();
  const ruleStats = useRuleStats();
  const accounts = useAccounts();
  const categories = useCategories();
  const [open, setOpen] = useState<OpenSheet>(highlight === null ? null : { kind: 'rule', id: highlight });
  const [seenHighlight, setSeenHighlight] = useState(highlight);
  const [search, setSearch] = useState('');

  // A new #rules?rule=<id> link while the screen is already open opens that rule.
  if (highlight !== seenHighlight) {
    setSeenHighlight(highlight);
    if (highlight !== null) setOpen({ kind: 'rule', id: highlight });
  }

  if (rules.isError) return <p className="note err">Не вдалося завантажити правила: {describeError(rules.error)}</p>;
  if (rules.data === undefined || accounts.data === undefined || categories.data === undefined) {
    return <p className="note loading">Завантажую…</p>;
  }

  const names = new Map(accounts.data.map((account) => [account.id, formatAccountName(account.name)]));
  const byId = new Map(rules.data.map((rule) => [rule.id, rule]));
  const categoryByName = new Map(categories.data.map((category) => [category.name, category]));
  const stats: Stats = new Map((ruleStats.data ?? []).map((entry) => [entry.id, entry]));
  const flagged = rules.data
    .filter((rule) => (stats.get(rule.id)?.issues.length ?? 0) > 0)
    .toSorted((left, right) => ruleSeverity(stats.get(left.id)) - ruleSeverity(stats.get(right.id)));
  const found = rules.data.filter((rule) => matchesSearch({ rule, search: search.trim(), names }));
  const merchantRules = found.filter((rule) => rule.priority < MCC_FALLBACK_PRIORITY);
  const fallbackRules = found.filter((rule) => rule.priority >= MCC_FALLBACK_PRIORITY);
  const openId = open?.kind === 'rule' ? open.id : null;
  const openRule = openId === null ? undefined : byId.get(openId);

  const openRuleSheet = (id: string) => setOpen({ kind: 'rule', id });
  const close = () => {
    setOpen(null);
    // Closing a deep-linked rule drops it from the address, so Back does not reopen it.
    if (highlight !== null) window.location.replace(buildHref({ view: 'rules' }));
  };

  return (
    <div className="view rules-view">
      <section>
        <SectionHead
          title={`Правила (${rules.data.filter((rule) => rule.priority < MCC_FALLBACK_PRIORITY).length})`}
          info={
            <>
              <p>
                Синхронізація бере перше правило за пріоритетом, де збігаються всі задані умови: текст (ціле слово в описі,
                контрагенті чи коментарі), MCC і рахунок. Апостроф може бути будь-який: «mcdonald's» ловить і «mcdonald’s».
              </p>
              <p>Менший пріоритет перевіряється раніше: «Uber Eats» (50) спрацює раніше за «Uber» (100). Запасні правила за MCC — від 1000.</p>
              <p>Число на правилі — скільки записів в історії воно розібрало першим. Натисни правило, щоб змінити чи видалити.</p>
            </>
          }
        >
          <button type="button" className="btn small primary" onClick={() => setOpen({ kind: 'new' })}>
            + Нове правило
          </button>
        </SectionHead>
        <input
          className="search"
          type="search"
          aria-label="Пошук правил"
          placeholder="Пошук: glovo, Продукти, 5411…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </section>

      {search === '' && flagged.length > 0 && (
        <AttentionList flagged={flagged} rules={byId} stats={stats} names={names} onOpen={openRuleSheet} />
      )}

      <section>
        <h2>
          За категоріями{' '}
          {search !== '' && (
            <span className="muted">· знайдено {pluralize(merchantRules.length + fallbackRules.length, ['правило', 'правила', 'правил'])}</span>
          )}
        </h2>
        {merchantRules.length === 0 ? (
          <p className="note">Нічого не знайдено.</p>
        ) : (
          <RuleGroups rules={merchantRules} stats={stats} names={names} categories={categoryByName} openId={openId} onOpen={openRuleSheet} />
        )}
      </section>

      <section>
        <details
          className="fold"
          open={(openRule !== undefined && openRule.priority >= MCC_FALLBACK_PRIORITY) || (search !== '' && fallbackRules.length > 0) || undefined}
        >
          <summary>Запасні правила за MCC ({fallbackRules.length})</summary>
          <p className="note" style={{ margin: '8px 0' }}>
            Спрацьовують, лише коли жодне правило за текстом не підійшло. Без збігу в історії — нормально: вони для нових покупок.
          </p>
          <RuleGroups rules={fallbackRules} stats={stats} names={names} categories={categoryByName} openId={openId} onOpen={openRuleSheet} />
        </details>
      </section>

      {open !== null && (open.kind === 'new' || openRule !== undefined) && (
        <RuleSheet
          key={open.kind === 'new' ? 'new' : open.id}
          rule={openRule ?? null}
          stat={openRule === undefined ? undefined : stats.get(openRule.id)}
          rules={byId}
          accounts={accounts.data}
          categories={categories.data}
          onOpenRule={openRuleSheet}
          onClose={close}
        />
      )}
    </div>
  );
};
