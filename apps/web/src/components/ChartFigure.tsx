import { type ReactNode, useId, useState } from 'react';

export type ChartTable = {
  columns: readonly string[];
  /** One row per point, cells already formatted; the first cell names the row. */
  rows: readonly { key: string; cells: readonly ReactNode[] }[];
};

/**
 * A chart with a spoken summary and the same numbers as a table, for screen readers and for
 * anyone who wants the exact figures rather than bar heights.
 */
export const ChartFigure = ({ summary, table, children }: { summary: string; table: ChartTable; children: ReactNode }) => {
  const [asTable, setAsTable] = useState(false);
  const id = useId();
  return (
    <figure className="chart-figure">
      <div className="chart-figure-bar">
        <button type="button" className="chart-toggle" aria-pressed={asTable} aria-controls={id} onClick={() => setAsTable(!asTable)}>
          {asTable ? 'графік' : 'таблиця'}
        </button>
      </div>
      <div id={id}>
        {asTable ? (
          <div className="tbl chart-table">
            <table>
              <caption className="sr-only">{summary}</caption>
              <thead>
                <tr>
                  {table.columns.map((column, index) => (
                    <th key={column} className={index === 0 ? undefined : 'r'} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.key}>
                    {row.cells.map((cell, index) =>
                      index === 0 ? (
                        <th key={table.columns[index]} scope="row">
                          {cell}
                        </th>
                      ) : (
                        <td key={table.columns[index]} className="r num">
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div role="img" aria-label={summary}>
            {children}
          </div>
        )}
      </div>
    </figure>
  );
};
