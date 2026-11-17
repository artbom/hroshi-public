import type { Month } from '@hroshi/schema';

import { describeError } from '../api.ts';
import { AmountBar } from '../components/AmountBar.tsx';
import { BarChart } from '../components/BarChart.tsx';
import { ChartFigure } from '../components/ChartFigure.tsx';
import { formatEur, formatMonthLong, formatMonthShort, pluralize } from '../format.ts';
import { useCategoryDetail } from '../queries.ts';
import { buildHref, buildTableHref } from '../route.ts';

export const CategoryDetailSection = ({
  month,
  range,
  category,
  spreadTax,
}: {
  month: Month;
  range: number;
  category: string;
  spreadTax: boolean;
}) => {
  const detail = useCategoryDetail({ month, range, category, spreadTax });

  if (detail.isError) return <p className="note err">{describeError(detail.error)}</p>;
  if (detail.data === undefined) return <p className="note loading">Завантажую {category}…</p>;

  const { months, merchants } = detail.data;
  const topMerchant = merchants[0]?.eur ?? 1;
  const from = months[0]?.month;
  const to = months.at(-1)?.month;

  return (
    <section>
      <h2>{category} — по місяцях</h2>
      <ChartFigure
        summary={`${category} по місяцях, у євро: ${months.map((entry) => `${formatMonthShort(entry.month)} ${formatEur(entry.eur)}`).join(', ')}.`}
        table={{
          columns: ['Місяць', 'Витрати'],
          rows: months.map((entry) => ({
            key: entry.month,
            cells: [formatMonthShort(entry.month), `${formatEur(entry.eur)}${entry.sparse ? ' (неповні дані)' : ''}`],
          })),
        }}
      >
        <BarChart
          height={150}
          unit="€"
          months={months.map((entry) => entry.month)}
          series={[{ values: months.map((entry) => entry.eur), color: 'var(--s1)' }]}
          sparse={months.map((entry) => entry.sparse)}
          tooltips={months.map((entry) => (
            <span key={entry.month}>
              <b>{formatMonthLong(entry.month)}</b>
              <br />
              <span className="num">{formatEur(entry.eur)}</span>
            </span>
          ))}
        />
      </ChartFigure>
      <div className="cats" style={{ marginTop: 14 }}>
        <h2 style={{ margin: 0 }}>Де найбільше за {pluralize(months.length, ['місяць', 'місяці', 'місяців'])}</h2>
        {merchants.length === 0 && <p className="note">Витрат у цій категорії немає.</p>}
        {merchants.map((entry) =>
          entry.unnamed === true ? (
            <a key={entry.key} className="plain" href={buildHref({ view: 'review' })} title="Банк не назвав отримувача: назви його в «Перевірці»">
              <AmountBar
                label={`без назви (${entry.count ?? 0})`}
                value={entry.eur}
                max={topMerchant}
                color="var(--muted)"
                display={formatEur(entry.eur)}
              />
            </a>
          ) : (
            <a key={entry.key} className="plain" href={buildTableHref({ payee: entry.key, category, from, to })}>
              <AmountBar label={entry.merchant} value={entry.eur} max={topMerchant} color="var(--s1)" display={formatEur(entry.eur)} />
            </a>
          ),
        )}
      </div>
    </section>
  );
};
