import {
  type AccountBalance,
  type AllTimeIssue,
  CONSENT_WARNING_DAYS,
  type InvestmentAccount,
  type Investments,
  type ReviewInbox,
  type SyncSource,
  type SyncSourceStatus,
} from '@hroshi/schema';
import type { ReactNode } from 'react';

import { describeCheckMoment, formatMoment, isAwaitingCheck, SOURCE_NAMES } from '../accounts/checks.ts';
import { InfoTip } from '../components/InfoTip.tsx';
import { SourceMark } from '../components/SourceMark.tsx';
import { formatAccountName, formatDate, formatDay, formatEur, formatMoney, formatWarning, pluralize } from '../format.ts';
import { findToday } from '../months.ts';
import { useAccounts, useInvestments, useReviewCount, useReviewInbox, useSyncStatus } from '../queries.ts';
import { buildHref } from '../route.ts';

/** A hand-kept account with money on it and no row for this long is probably missing something. */
const STALE_DAYS = 21;
/** A broker statement older than this no longer says much about today's value. */
const REPORT_STALE_DAYS = 7;
const DAY_MS = 86_400_000;

type Tone = 'ok' | 'warn' | 'bad' | 'off';
/** `why` is the hover text: what the finding means and how to clear it. */
type TrustItem = { key: string; tone: Tone; text: string; href: string; why?: string };
type TrustGroup = { key: string; tone: Tone; summary: string; href: string; items: TrustItem[] };

/** Problems first: a red finding, then the amber ones, then sources that are simply not set up. */
const TONE_ORDER: Readonly<Record<Tone, number>> = { bad: 0, warn: 1, off: 2, ok: 3 };

const sortByTone = <T extends { tone: Tone }>(entries: readonly T[]): T[] =>
  entries.toSorted((left, right) => TONE_ORDER[left.tone] - TONE_ORDER[right.tone]);

/** Sources whose sync reports a balance; without one there is nothing to compare the tracker with. */
const BALANCE_SOURCES: ReadonlySet<SyncSourceStatus['source']> = new Set(['mono', 'revolut', 'binance']);

const ISSUE_LABELS: Readonly<Record<AllTimeIssue, string>> = {
  'unknown-credits': 'поповнення без суми зарахування',
  duplicates: 'рухи, схожі на дублі',
  'negative-history': 'бракує записаних виводів',
  'no-flows': 'жодного поповнення в записах',
  'unexplained-start': 'старт не пояснений поповненнями',
};

const daysSince = (date: string) => Math.round((Date.parse(`${findToday()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / DAY_MS);

const accountHref = (account: Pick<AccountBalance, 'id'>) => buildHref({ view: 'accounts', param: account.id });

const isLive = (account: AccountBalance) => !account.archived && !(account.passThrough && account.balance === 0);

const checkAccounts = (accounts: readonly AccountBalance[]): TrustGroup => {
  const checkable = accounts.filter((account) => account.check !== null || isAwaitingCheck(account));
  const items = checkable.flatMap((account): TrustItem[] => {
    const name = formatAccountName(account.name);
    const { check } = account;
    if (check === null) {
      return [{ key: account.id, tone: 'warn', text: `${name}: без звірки — синхронізація ще не повідомила баланс цього рахунку`, href: accountHref(account) }];
    }
    if (check.matches) return [];
    return [
      {
        key: account.id,
        tone: 'bad',
        text: `${name}: Δ ${formatMoney(check.difference, account.currency)} проти ${SOURCE_NAMES[check.source]} (звірено ${describeCheckMoment(check)})`,
        href: accountHref(account),
      },
    ];
  });
  const matching = checkable.length - items.length;
  const bad = items.some((item) => item.tone === 'bad');
  return {
    key: 'checks',
    tone: bad ? 'bad' : items.length > 0 ? 'warn' : 'ok',
    summary: `${matching} з ${pluralize(checkable.length, ['рахунку', 'рахунків', 'рахунків'])} як у банку чи брокера`,
    href: items[0]?.href ?? buildHref({ view: 'accounts' }),
    items,
  };
};

/** Hand-kept accounts that hold money and have gone quiet: a missed purchase or a missed valuation. */
const checkStaleAccounts = (accounts: readonly AccountBalance[]): TrustGroup => {
  const items = accounts.flatMap((account): TrustItem[] => {
    if (account.syncSource !== null || account.check !== null || account.balance === 0 || account.kind === 'receivable') return [];
    const name = formatAccountName(account.name);
    if (account.kind === 'investment') {
      const since = account.valuedAt ?? account.openingDate;
      const days = daysSince(since);
      if (days < STALE_DAYS) return [];
      const what = account.valuedAt === null ? `оцінок не було з ${formatDay(since)}` : `остання оцінка ${formatDay(since)}`;
      return [{ key: account.id, tone: 'warn', text: `${name}: ${what}`, href: accountHref(account) }];
    }
    if (account.lastRowDate === null) return [];
    // A recently confirmed opening balance is as fresh as a row: nothing can be missing before it.
    const days = daysSince(account.lastRowDate > account.openingDate ? account.lastRowDate : account.openingDate);
    return days < STALE_DAYS
      ? []
      : [
          {
            key: account.id,
            tone: 'warn',
            text: `${name}: ${pluralize(days, ['день', 'дні', 'днів'])} без записів`,
            href: accountHref(account),
            why: 'Рахунок ведеться вручну й тримає гроші, але давно без записів: можливо, бракує покупки. Якщо він не активний або закритий, переказ залишку на інший рахунок обнулить його, і попередження зникне.',
          },
        ];
  });
  return {
    key: 'stale',
    tone: items.length > 0 ? 'warn' : 'ok',
    summary: pluralize(items.length, ['рахунок давно без записів', 'рахунки давно без записів', 'рахунків давно без записів']),
    href: items[0]?.href ?? buildHref({ view: 'accounts' }),
    items,
  };
};

/**
 * Why a broker's all-time result is not a profit yet. Today's balance can still match («✓»):
 * this is about the deposit history behind it, not about the balance.
 */
const checkBrokerHistory = (investments: Investments | undefined): TrustGroup => {
  const items = (investments?.accounts ?? [])
    .filter((holding) => holding.allTimeIssues.length > 0)
    .map(
      (holding): TrustItem => ({
        key: `${holding.account.id}-issues`,
        tone: 'warn',
        text: `${formatAccountName(holding.account.name)}: історія внесків неповна — ${holding.allTimeIssues.map((issue) => ISSUE_LABELS[issue]).join(', ')}`,
        href: buildHref({ view: 'investments' }),
      }),
    );
  return {
    key: 'brokers',
    tone: items.length > 0 ? 'warn' : 'ok',
    summary: `${pluralize(items.length, ['інвестиція', 'інвестиції', 'інвестицій'])}: історія внесків неповна`,
    href: buildHref({ view: 'investments' }),
    items,
  };
};

const listStaleReport = (holding: InvestmentAccount): TrustItem[] => {
  const { report } = holding;
  if (report === null || daysSince(report.asOf) <= REPORT_STALE_DAYS) return [];
  return [
    {
      key: `${holding.account.id}-report`,
      tone: 'warn',
      text: `${formatAccountName(holding.account.name)}: звіт брокера на ${formatDay(report.asOf)} — час завантажити новий`,
      href: buildHref({ view: 'sync' }),
    },
  ];
};

/** A statement gone old says little about today's value. */
const checkBrokerReports = (investments: Investments | undefined): TrustGroup => {
  const items = (investments?.accounts ?? []).flatMap(listStaleReport);
  return {
    key: 'reports',
    tone: items.length > 0 ? 'warn' : 'ok',
    summary: pluralize(items.length, ['звіт брокера застарів', 'звіти брокерів застаріли', 'звітів брокерів застаріли']),
    href: buildHref({ view: 'sync' }),
    items,
  };
};

const checkSyncs = (statuses: readonly SyncSourceStatus[], now: number): TrustGroup => {
  const href = buildHref({ view: 'sync' });
  const items = statuses.flatMap((status): TrustItem[] => {
    const name = SOURCE_NAMES[status.source];
    if (!status.configured) return [{ key: `${status.source}-off`, tone: 'off', text: `${name}: не налаштовано`, href }];
    const found: TrustItem[] = [];
    const run = status.lastRun;
    if (run?.status === 'error') {
      found.push({ key: `${status.source}-error`, tone: 'bad', text: `${name}: помилка — ${formatWarning(run.error ?? 'без опису')}`, href });
    }
    for (const warning of run?.warnings ?? []) {
      found.push({ key: `${status.source}-${warning}`, tone: 'warn', text: `${name}: ${formatWarning(warning)}`, href });
    }
    const validUntil = status.consentValidUntil;
    const daysLeft = validUntil === null ? null : (Date.parse(validUntil) - now) / DAY_MS;
    if (validUntil !== null && daysLeft !== null && daysLeft < CONSENT_WARNING_DAYS) {
      found.push({
        key: `${status.source}-consent`,
        tone: daysLeft < 0 ? 'bad' : 'warn',
        text: `${name}: згода банку ${daysLeft < 0 ? 'закінчилась' : 'закінчується'} ${formatDate(validUntil)}`,
        href,
      });
    }
    return found;
  });
  return {
    key: 'syncs',
    tone: items.some((item) => item.tone === 'bad') ? 'bad' : items.length > 0 ? 'warn' : 'ok',
    summary: pluralize(items.length, ['попередження синхронізації', 'попередження синхронізації', 'попереджень синхронізації']),
    href,
    items,
  };
};

/** The category unanswered spending lands in: what the owner overstates by leaving the queue. */
const FALLBACK_CATEGORY = 'Інше';

/**
 * What the review queue weighs in euros: all of it, and the part that sits in «Інше» spending right
 * now. Parked groups are left out, like the badge leaves them out of its count.
 */
const describeBacklog = ({ count, inbox }: { count: number; inbox: ReviewInbox | undefined }): string => {
  const rows = pluralize(count, ['запис', 'записи', 'записів']);
  if (inbox === undefined) return `${rows} на перевірку`;
  const today = findToday();
  const waiting = inbox.groups.filter((group) => group.snoozedUntil === null || group.snoozedUntil <= today);
  const totalEur = waiting.reduce((sum, group) => sum + Math.abs(group.totalEur), 0);
  const otherEur = waiting
    .flatMap((group) => group.impact)
    .filter((impact) => impact.kind === 'spend' && impact.category === FALLBACK_CATEGORY)
    .reduce((sum, impact) => sum + impact.eur, 0);
  // Parentheses, not «·»: on Огляд the backlog sits in a line of other findings joined by «·».
  const other = Math.round(otherEur) > 0 ? `, з них ${formatEur(otherEur)} у витратах «${FALLBACK_CATEGORY}»` : '';
  return `${rows} на перевірку (≈\u00a0${formatEur(totalEur)}${other})`;
};

type SourceState = { tone: Tone; text: string; why: string };

/**
 * The freshness of each source in one chip: when it last ran, and whether its balances matched.
 * «✓» means one thing only: today's balance agrees. An older agreement shows its day instead.
 */
const describeSource = (status: SyncSourceStatus): SourceState => {
  if (!status.configured) return { tone: 'off', text: 'не налаштовано', why: 'Немає ключів доступу в налаштуваннях сервера.' };
  if (status.lastRun?.status === 'error') {
    return { tone: 'bad', text: 'помилка', why: `Остання синхронізація впала: ${formatWarning(status.lastRun.error ?? 'без опису')}.` };
  }
  const at = status.lastSuccessAt;
  if (at === null) return { tone: 'warn', text: 'ще не було', why: 'Синхронізація ще жодного разу не пройшла успішно.' };
  const moment = formatMoment(at);
  const mismatches = status.checks.filter((check) => !check.matches).length;
  if (mismatches > 0) {
    return {
      tone: 'warn',
      text: `${moment} · ${pluralize(mismatches, ['розбіжність', 'розбіжності', 'розбіжностей'])}`,
      why: 'Баланс трекера не збігся з тим, що назвало джерело.',
    };
  }
  if (status.checks.length === 0) {
    return BALANCE_SOURCES.has(status.source)
      ? {
          tone: 'warn',
          text: `${moment} · без звірки`,
          why: 'Остання синхронізація не повідомила балансів рахунків, тож порівняти трекер нема з чим. Звірка з’явиться після синхронізації, яка їх отримає.',
        }
      : { tone: 'ok', text: moment, why: 'Рядки оновлено; баланс з цього джерела не звіряється.' };
  }
  const today = findToday();
  // A bank's balance (Mono's last statement line, a Revolut reading) holds until the next line,
  // so the sync that read it vouches for that day; a broker or wallet file only for its own day.
  const syncDay = new Date(at).toLocaleDateString('en-CA');
  const oldest =
    status.checks
      .map((check) => (check.basis === 'statement' || check.basis === 'sync' ? syncDay : check.checkedAt.slice(0, 10)))
      .toSorted()[0] ?? today;
  return oldest >= today
    ? { tone: 'ok', text: `${moment} · ✓`, why: 'Сьогоднішній баланс збігається з джерелом.' }
    : {
        tone: 'ok',
        text: `${moment} · збіг на ${formatDay(oldest)}`,
        why: `Баланс збігся зі звітом на ${formatDay(oldest)}; за сьогодні звіту ще немає.`,
      };
};

/** A source's health: its mark with the status dot on the corner; a check that is no source keeps the bare dot. */
const StatusMark = ({ tone, source }: { tone: Tone; source?: SyncSource | undefined }) => {
  const dot = <span className={`dot ${tone === 'ok' ? '' : tone}`.trim()} aria-hidden="true" />;
  return source === undefined ? (
    dot
  ) : (
    <span className="mark-status">
      <SourceMark source={source} size="sm" />
      {dot}
    </span>
  );
};

const Chip = ({
  tone,
  href,
  title,
  source,
  children,
}: {
  tone: Tone;
  href: string;
  title?: string | undefined;
  source?: SyncSource | undefined;
  children: ReactNode;
}) => (
  <a href={href} title={title}>
    <StatusMark tone={tone} source={source} />
    {children}
  </a>
);

const TrustInfo = () => (
  <InfoTip label="довіра до даних">
    <p>Звірка — баланс трекера проти банку, брокера чи гаманця Binance на момент, коли ті його назвали. «✓» — сьогоднішній баланс збігається.</p>
    <p>
      Давно без записів — рахунки, які ведуться вручну, з грошима, але без записів чи оцінок понад{' '}
      {pluralize(STALE_DAYS, ['день', 'дні', 'днів'])}.
    </p>
    <p>
      Історія внесків неповна — поповнення без суми, схожі дублі, незаписані виводи. Сьогоднішній баланс при цьому може збігатися, але
      результат за весь час неточний.
    </p>
  </InfoTip>
);

/**
 * «Довіра до даних»: whether the numbers on the page can be trusted, one link per thing to look
 * at — balances that disagree or were never compared, hand-kept accounts gone quiet, gaps in the
 * brokers' history, sync errors and warnings, rows waiting for review. Огляд gets one line and the
 * fold; Синхронізація gets every chip and the full list.
 */
export const TrustPanel = ({ expanded = false }: { expanded?: boolean }) => {
  const status = useSyncStatus();
  const accounts = useAccounts();
  const investments = useInvestments();
  const review = useReviewCount();
  const inbox = useReviewInbox();
  if (status.data === undefined || accounts.data === undefined) return null;

  const live = accounts.data.filter(isLive);
  // The panel is re-rendered on every refetch; "now" for a consent weeks away needs no finer clock.
  const now = Date.parse(`${findToday()}T12:00:00Z`);
  const checks = checkAccounts(live);
  const groups = [
    checks,
    checkStaleAccounts(live),
    checkBrokerHistory(investments.data),
    checkBrokerReports(investments.data),
    checkSyncs(status.data, now),
  ];
  const reviewCount = review.data ?? 0;
  const backlog = describeBacklog({ count: reviewCount, inbox: inbox.data });
  const reviewItem: TrustItem | null =
    reviewCount > 0 ? { key: 'review', tone: 'warn', text: backlog, href: buildHref({ view: 'review' }) } : null;
  const items = sortByTone([...groups.flatMap((group) => group.items), ...(reviewItem === null ? [] : [reviewItem])]);
  const sources = status.data.map((entry) => {
    const state = describeSource(entry);
    return { entry, state, tone: state.tone };
  });
  const syncHref = buildHref({ view: 'sync' });
  // The review queue is one chip, not a group: its rows are listed on «Перевірка», not here.
  const warningGroups = groups.filter((group) => group.key !== 'checks' && group.items.length > 0);
  const gist = [
    ...warningGroups.map((group) => group.summary),
    ...(reviewCount > 0 ? [backlog] : []),
  ];

  const list = (
    <ul className="trust-list">
      {items.map((item) => (
        <li key={item.key}>
          <a href={item.href} title={item.why}>
            <span className={`dot ${item.tone === 'ok' ? '' : item.tone}`.trim()} aria-hidden="true" />
            {item.text}
          </a>
        </li>
      ))}
    </ul>
  );

  if (!expanded) {
    return (
      <section className="trust compact" aria-labelledby="trust-title">
        <div className="section-head">
          <h2 id="trust-title">
            Довіра до даних
            <TrustInfo />
          </h2>
          <a className="link small" href={syncHref}>
            Синхронізація →
          </a>
        </div>
        <p className="trust-line">
          {sortByTone(sources).map(({ entry, state }) => (
            <a key={entry.source} href={syncHref} title={state.why} className={`trust-source ${state.tone}`}>
              <StatusMark tone={state.tone} source={entry.source} />
              <b>{SOURCE_NAMES[entry.source]}</b> {state.text}
            </a>
          ))}
          <a href={checks.href} className={`trust-source ${checks.tone}`}>
            <StatusMark tone={checks.tone} />
            {checks.summary}
          </a>
        </p>
        {items.length > 0 && (
          <details className="fold trust-fold">
            <summary>
              <span className="trust-gist-head">Що саме перевірити ({items.length})</span>
              {gist.length > 0 && <span className="trust-gist">{gist.join(' · ')}</span>}
            </summary>
            {list}
          </details>
        )}
      </section>
    );
  }

  const chips = sortByTone([
    ...sources.map(({ entry, state }) => ({
      key: entry.source,
      source: entry.source,
      tone: state.tone,
      href: syncHref,
      title: state.why,
      content: (
        <>
          <b>{SOURCE_NAMES[entry.source]}</b> {state.text}
        </>
      ),
    })),
    {
      key: checks.key,
      tone: checks.tone,
      href: checks.href,
      title: undefined,
      content: checks.tone === 'ok' ? `✓ ${checks.summary}` : checks.summary,
    },
    ...warningGroups.map((group) => ({ key: group.key, tone: group.tone, href: group.href, title: undefined, content: group.summary })),
    ...(reviewCount > 0
      ? [
          {
            key: 'review',
            tone: 'warn' as const,
            href: buildHref({ view: 'review' }),
            title: undefined,
            content: backlog,
          },
        ]
      : []),
  ]);

  return (
    <section className="trust" aria-labelledby="trust-title">
      <div className="section-head">
        <h2 id="trust-title">
          Довіра до даних
          <TrustInfo />
        </h2>
      </div>
      <nav className="health" aria-label="Стан даних">
        {chips.map((chip) => (
          <Chip key={chip.key} tone={chip.tone} href={chip.href} title={chip.title} source={'source' in chip ? chip.source : undefined}>
            {chip.content}
          </Chip>
        ))}
      </nav>
      {items.length > 0 && list}
    </section>
  );
};
