import { shiftDate } from '@hroshi/domain';
import type { BudgetLine, IsoDate, MonthBudget } from '@hroshi/schema';

import { formatDigestMoney, formatEur } from '../digest/compose.ts';
import { COLORS, formatWhole, h, renderPicture, renderSection, truncate } from '../picture.ts';

const WIDTH = 1080;
/** The header and the total above the orientirs, then one row per line: the canvas grows with the orientirs. */
const HEAD_HEIGHT = 690;
const LINE_HEIGHT = 69;
const capitalize = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

const describeMonthName = (month: string) => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('uk-UA', { month: 'long' });

/** «вчора» in the morning report; the date itself when the report is asked for another day. */
const describeLastDay = ({ asOf, today }: { asOf: IsoDate; today: IsoDate }) => {
  if (asOf === today) return 'сьогодні';
  if (asOf === shiftDate(today, -1)) return 'вчора';
  return new Date(`${asOf}T12:00:00Z`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
};

const isClosed = (budget: MonthBudget) => budget.total.projectedEur === null;

/** Over the limit already, heading over it by the month's end, or on track. */
const describeLineState = ({ limitEur, spentEur, projectedEur }: BudgetLine) => {
  if (spentEur > limitEur) return { color: COLORS.up, note: `+${formatEur(spentEur - limitEur)} понад` };
  if (projectedEur !== null && projectedEur > limitEur) return { color: COLORS.warn, note: `прогноз +${formatEur(projectedEur - limitEur)}` };
  return { color: COLORS.down, note: `залишилось ${formatEur(limitEur - spentEur)}` };
};

/** Spent as a solid bar, where the month is heading as a faint extension, and the limit as a tick once a bar passes it. */
const renderBar = ({ line, color, height }: { line: BudgetLine; color: string; height: number }) => {
  const scale = Math.max(1, line.limitEur, line.spentEur, line.projectedEur ?? 0);
  const toWidth = (value: number) => `${Math.min(100, (Math.max(0, value) / scale) * 100)}%`;
  const fill = { position: 'absolute', left: 0, top: 0, height, background: color, borderRadius: height / 2 };
  return h(
    { position: 'relative', height, background: COLORS.line, borderRadius: height / 2 },
    line.projectedEur !== null && line.projectedEur > line.spentEur ? h({ ...fill, width: toWidth(line.projectedEur), opacity: 0.3 }) : null,
    h({ ...fill, width: toWidth(Math.max(line.spentEur, scale * 0.01)) }),
    line.limitEur < scale ? h({ position: 'absolute', left: toWidth(line.limitEur), top: -5, width: 4, height: height + 10, background: COLORS.fg }) : null,
  );
};

const renderLine = ({ name, line }: { name: string; line: BudgetLine }) => {
  const state = describeLineState(line);
  return h(
    { flexDirection: 'column', gap: 8 },
    h(
      { justifyContent: 'space-between', alignItems: 'baseline', fontSize: 24 },
      h({}, truncate(name, 22)),
      h(
        { gap: 16, alignItems: 'baseline' },
        h({ fontSize: 20, color: state.color }, state.note),
        h({ fontWeight: 700 }, `${formatWhole(line.spentEur)} / ${formatEur(line.limitEur)}`),
      ),
    ),
    renderBar({ line, color: state.color, height: 12 }),
  );
};

/** The month's end: where spending is heading while it runs, what was put aside once it is over. */
const renderOutlook = (budget: MonthBudget) => {
  const { total } = budget;
  if (total.projectedEur === null) {
    const saved = budget.incomeEur - total.spentEur;
    return h(
      { fontSize: 26, color: saved >= budget.goalEur ? COLORS.down : COLORS.warn },
      `Відкладено ${formatEur(saved)} з цілі ${formatEur(budget.goalEur)}`,
    );
  }
  const over = total.projectedEur - total.limitEur;
  return h(
    { fontSize: 26, color: over > 0 ? COLORS.warn : COLORS.down },
    `Прогноз на кінець місяця: ${formatEur(total.projectedEur)} · ${over > 0 ? `на ${formatEur(over)} понад бюджет` : `запас ${formatEur(-over)}`}`,
  );
};

// Manrope has no ≈, so the picture approximates with ~.
export const renderBudget = ({ budget, today }: { budget: MonthBudget; today: IsoDate }): Promise<Buffer> => {
  const { total } = budget;
  const remaining = total.limitEur - total.spentEur;
  const daysLeft = budget.daysInMonth - budget.daysElapsed;
  const state = describeLineState(total);

  return renderPicture({
    width: WIDTH,
    height: HEAD_HEIGHT + LINE_HEIGHT * (budget.categories.length + 1),
    gap: 22,
    children: [
      h(
        { justifyContent: 'space-between', alignItems: 'baseline' },
        h({ fontSize: 36, fontWeight: 700 }, 'Гроші · бюджет'),
        h(
          { fontSize: 28, color: COLORS.muted },
          isClosed(budget)
            ? `${describeMonthName(budget.month)} · підсумок`
            : `${describeMonthName(budget.month)} · ${budget.daysElapsed} з ${budget.daysInMonth} днів`,
        ),
      ),
      h(
        { flexDirection: 'column', gap: 18, padding: '30px 34px', background: COLORS.surface, borderRadius: 28, border: `1px solid ${COLORS.line}` },
        h({ fontSize: 22, letterSpacing: 2, color: COLORS.muted, textTransform: 'uppercase' }, remaining >= 0 ? 'Залишилось' : 'Перевищено'),
        h(
          { alignItems: 'baseline', gap: 20 },
          h({ fontSize: 96, fontWeight: 700, lineHeight: 1, color: state.color }, formatEur(Math.abs(remaining))),
          h({ fontSize: 28, color: COLORS.muted }, `з ${formatEur(total.limitEur)} бюджету`),
        ),
        renderBar({ line: total, color: state.color, height: 24 }),
        h(
          { justifyContent: 'space-between', fontSize: 24 },
          h({}, `витрачено ${formatEur(total.spentEur)}`),
          h(
            { color: COLORS.muted },
            isClosed(budget) ? 'місяць закрито' : remaining > 0 && daysLeft > 0 ? `~${formatEur(remaining / daysLeft)} на день` : 'бюджет вичерпано',
          ),
        ),
        renderOutlook(budget),
      ),
      h(
        { justifyContent: 'space-between', fontSize: 22, color: COLORS.muted, padding: '0 6px' },
        h({}, `Ціль ${formatDigestMoney(budget.goal)}/міс (~${formatEur(budget.goalEur)}) · дохід ~${formatEur(budget.usualIncomeEur)}`),
        h({}, `${describeLastDay({ asOf: budget.asOf, today })}: ${formatEur(budget.lastDaySpentEur)}`),
      ),
      renderSection(
        'Орієнтири',
        ...budget.categories.map((entry) => renderLine({ name: entry.category, line: entry })),
        h({ height: 1, background: COLORS.line }),
        renderLine({ name: 'Решта категорій', line: budget.rest }),
      ),
    ],
  });
};

const MAX_NAMED = 3;

export const describeBudgetCaption = ({ budget, today, reviewCount }: { budget: MonthBudget; today: IsoDate; reviewCount: number }): string => {
  const { total } = budget;
  const month = capitalize(describeMonthName(budget.month));
  const remaining = total.limitEur - total.spentEur;
  const daysLeft = budget.daysInMonth - budget.daysElapsed;
  const lines = [...budget.categories, { category: 'решта категорій', ...budget.rest }];
  const over = lines.filter((entry) => entry.spentEur > entry.limitEur);
  const atRisk = lines.filter(
    (entry) => entry.spentEur <= entry.limitEur && entry.projectedEur !== null && entry.projectedEur > entry.limitEur,
  );
  const outlook =
    total.projectedEur === null
      ? `Відкладено ${formatEur(budget.incomeEur - total.spentEur)} з цілі ${formatEur(budget.goalEur)}.`
      : `Прогноз на кінець місяця: ${formatEur(total.projectedEur)} — ${
          total.projectedEur > total.limitEur
            ? `на ${formatEur(total.projectedEur - total.limitEur)} понад бюджет`
            : `у межах, запас ${formatEur(total.limitEur - total.projectedEur)}`
        }.`;

  return [
    isClosed(budget)
      ? `${month} закрито: витрачено ${formatEur(total.spentEur)} з бюджету ${formatEur(total.limitEur)}` +
        (remaining < 0 ? ` (+${formatEur(-remaining)}).` : ` (запас ${formatEur(remaining)}).`)
      : `${month}, ${budget.daysElapsed} з ${budget.daysInMonth} днів: витрачено ${formatEur(total.spentEur)} з ${formatEur(total.limitEur)}, ` +
        (remaining >= 0
          ? `залишилось ${formatEur(remaining)}${daysLeft > 0 ? ` (≈ ${formatEur(remaining / daysLeft)}/день)` : ''}.`
          : `перевищено на ${formatEur(-remaining)}.`),
    isClosed(budget) ? null : `${capitalize(describeLastDay({ asOf: budget.asOf, today }))}: ${formatEur(budget.lastDaySpentEur)}.`,
    outlook,
    over.length === 0
      ? null
      : `Понад орієнтир: ${over
          .slice(0, MAX_NAMED)
          .map((entry) => `${entry.category} (${formatEur(entry.spentEur)} з ${formatEur(entry.limitEur)})`)
          .join(', ')}.`,
    atRisk.length === 0
      ? null
      : `Може не вистачити: ${atRisk
          .slice(0, MAX_NAMED)
          .map((entry) => `${entry.category} (прогноз ${formatEur(entry.projectedEur ?? 0)} з ${formatEur(entry.limitEur)})`)
          .join(', ')}.`,
    `Ціль: ${formatDigestMoney(budget.goal)} на місяць (≈ ${formatEur(budget.goalEur)}).`,
    reviewCount === 0 ? null : `На перевірці: ${reviewCount} — поки вони там, цифри неточні.`,
  ]
    .filter(Boolean)
    .join('\n');
};
