import { formatDigestMoney, formatEur, type WeeklyDigest } from './compose.ts';
import { COLORS, h, renderPicture, renderSection, truncate } from '../picture.ts';

const WIDTH = 1080;
const HEIGHT = 1350;

const MAX_OVERDUE = 3;

/** The font has no ✓, so sync health is a coloured dot. */
const describeSyncColor = (source: WeeklyDigest['sync'][number]) => {
  if (source.lastRun?.status === 'error') return COLORS.up;
  if (source.lastRun?.status === 'ok') return COLORS.down;
  return COLORS.line;
};

const formatDay = (date: string, withMonth: boolean) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('uk-UA', withMonth ? { day: 'numeric', month: 'long' } : { day: 'numeric' });

const describeRange = (from: string, to: string) =>
  from.slice(0, 7) === to.slice(0, 7)
    ? `${formatDay(from, false)}–${formatDay(to, true)}`
    : `${formatDay(from, true)} – ${formatDay(to, true)}`;

const renderCategoryRow = ({ category, eur, usualEur }: WeeklyDigest['digest']['categories'][number], scale: number) =>
  h(
    { flexDirection: 'column', gap: 8 },
    h(
      { justifyContent: 'space-between', alignItems: 'baseline', fontSize: 26 },
      h({ color: COLORS.fg }, category),
      h(
        { gap: 12, alignItems: 'baseline' },
        h({ fontSize: 20, color: COLORS.muted }, usualEur > 0 ? `зазвичай ${formatEur(usualEur)}` : 'зазвичай ~0'),
        h({ color: COLORS.fg, fontWeight: 700 }, formatEur(eur)),
      ),
    ),
    h(
      { position: 'relative', height: 16, background: COLORS.line, borderRadius: 8 },
      h({ width: `${Math.max(2, (eur / scale) * 100)}%`, height: 16, background: COLORS.bar, borderRadius: 8 }),
      // The usual week as a tick on the same scale: past the tick means above normal.
      usualEur > 0
        ? h({ position: 'absolute', left: `${Math.min(99, (usualEur / scale) * 100)}%`, top: -6, width: 4, height: 28, background: COLORS.fg })
        : null,
    ),
  );

const renderOverdue = (overdue: WeeklyDigest['overdue'], nameLength: number) =>
  renderSection(
    'Прострочено',
    ...overdue.slice(0, MAX_OVERDUE).map((payment) =>
      h(
        { justifyContent: 'space-between', fontSize: 22, gap: 12 },
        h({ color: COLORS.fg }, truncate(payment.name, nameLength)),
        h(
          { gap: 12, alignItems: 'baseline' },
          h({ fontWeight: 700 }, formatDigestMoney(payment)),
          h({ color: COLORS.warn, fontWeight: 700 }, `${payment.days} дн.`),
        ),
      ),
    ),
    overdue.length > MAX_OVERDUE ? h({ fontSize: 20, color: COLORS.muted }, `і ще ${overdue.length - MAX_OVERDUE}`) : null,
  );

const renderLimits = (limits: WeeklyDigest['digest']['limits'], columns: number) =>
  renderSection(
    'Орієнтири на місяць',
    // Two columns when it has the width: a month can end with half a dozen limits near their end.
    h(
      { flexWrap: 'wrap', columnGap: 40, rowGap: 10 },
      ...limits.slice(0, columns * 3).map((limit) =>
        h(
          {
            width: columns === 2 ? '45%' : '100%',
            justifyContent: 'space-between',
            fontSize: 22,
            color: limit.spentEur > limit.limitEur ? COLORS.up : COLORS.fg,
          },
          h({}, truncate(limit.category, 16)),
          h({ fontWeight: 700 }, `${Math.round(limit.spentEur)} / ${limit.limitEur} €`),
        ),
      ),
    ),
  );

/** Overdue payments and limits share one row when both are there, so the picture keeps its height. */
const renderAlerts = ({ overdue, limits }: { overdue: WeeklyDigest['overdue']; limits: WeeklyDigest['digest']['limits'] }) => {
  if (overdue.length === 0) return limits.length === 0 ? null : renderLimits(limits, 2);
  if (limits.length === 0) return renderOverdue(overdue, 32);
  return h(
    { gap: 22 },
    h({ flex: 1, width: '50%' }, renderOverdue(overdue, 16)),
    h({ flex: 1, width: '50%' }, renderLimits(limits, 1)),
  );
};

export const renderWeeklyDigest = (weekly: WeeklyDigest): Promise<Buffer> => {
  const { kind, digest, reviewCount, sync, overdue, budget } = weekly;
  const saved = digest.incomeEur - digest.spentEur;
  const change = digest.usualSpentEur > 0 ? (digest.spentEur / digest.usualSpentEur - 1) * 100 : null;
  const scale = Math.max(1, ...digest.categories.flatMap((entry) => [entry.eur, entry.usualEur]));
  // One line for income and budget: the canvas has no height to spare for a second one.
  const summary = [
    digest.incomeEur <= 0
      ? null
      : kind === 'week'
        ? `дохід за тиждень: ${formatEur(digest.incomeEur)}`
        : `дохід ${formatEur(digest.incomeEur)} · відкладено ${formatEur(saved)} (${Math.round((saved / digest.incomeEur) * 100)}%)`,
    budget === null
      ? null
      : kind === 'week'
        ? `бюджет місяця ${formatEur(budget.total.spentEur)} з ${formatEur(budget.total.limitEur)}`
        : `ціль ${formatEur(budget.goalEur)}`,
  ]
    .filter((note) => note !== null)
    .join(' · ');

  return renderPicture({
    width: WIDTH,
    height: HEIGHT,
    gap: 22,
    children: [
    h(
      { justifyContent: 'space-between', alignItems: 'baseline' },
      h({ fontSize: 36, fontWeight: 700 }, kind === 'week' ? 'Гроші · тиждень' : 'Гроші · місяць'),
      h(
        { fontSize: 28, color: COLORS.muted },
        kind === 'week'
          ? describeRange(digest.from, digest.to)
          : new Date(`${digest.from}T12:00:00Z`).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }),
      ),
    ),
    h(
      { alignItems: 'flex-end', gap: 24 },
      h({ fontSize: 88, fontWeight: 700, lineHeight: 1 }, formatEur(digest.spentEur)),
      h(
        { flexDirection: 'column', fontSize: 26, paddingBottom: 8, color: COLORS.muted },
        h({}, 'витрачено'),
        change === null
          ? null
          : h(
              { color: change > 0 ? COLORS.up : COLORS.down, fontWeight: 700 },
              `${change >= 0 ? '+' : ''}${Math.round(change)}% до звичайного ${kind === 'week' ? 'тижня' : 'місяця'} (${formatEur(digest.usualSpentEur)})`,
            ),
      ),
    ),
    summary === '' ? null : h({ fontSize: 26, color: COLORS.accent }, `${summary.charAt(0).toUpperCase()}${summary.slice(1)}`),
    renderSection(
      'Категорії',
      // Overdue payments need the room of one category row to keep the footer on the canvas.
      ...digest.categories.slice(0, overdue.length > 0 ? 4 : 5).map((entry) => renderCategoryRow(entry, scale)),
    ),
    h(
      { gap: 22 },
      h(
        { flex: 1, width: '50%' },
        renderSection(
          'Найбільші покупки',
          ...digest.largest.map((expense) =>
            h(
              { flexDirection: 'column', fontSize: 24 },
              h({ justifyContent: 'space-between' }, h({}, truncate(expense.merchant, 24)), h({ fontWeight: 700 }, formatEur(expense.eur))),
              h({ fontSize: 20, color: COLORS.muted }, `${formatDay(expense.date, true)} · ${expense.category}`),
            ),
          ),
        ),
      ),
      h(
        { flex: 1, width: '50%' },
        renderSection(
          'Де найбільше',
          ...digest.merchants.slice(0, 4).map((merchant) =>
            h(
              { justifyContent: 'space-between', fontSize: 24 },
              h({}, `${truncate(merchant.merchant, 20)}${merchant.count > 1 ? ` ×${merchant.count}` : ''}`),
              h({ fontWeight: 700 }, formatEur(merchant.eur)),
            ),
          ),
        ),
      ),
    ),
    renderAlerts({ overdue, limits: digest.limits }),
    h(
      { marginTop: 'auto', justifyContent: 'space-between', fontSize: 20, color: COLORS.muted },
      h({}, reviewCount > 0 ? `На перевірці: ${reviewCount}` : 'Перевірка порожня'),
      h(
        { gap: 16 },
        ...sync.map((source) =>
          h(
            { alignItems: 'center', gap: 8 },
            h({ width: 12, height: 12, borderRadius: 6, background: describeSyncColor(source) }),
            h({}, source.source),
          ),
        ),
      ),
    ),
    ],
  });
};
