import type { Month } from '@hroshi/schema';
import { useEffect, useRef, useState } from 'react';

import { formatMonthShort } from '../format.ts';
import { findCurrentMonth } from '../months.ts';

const MONTH_NUMBERS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'] as const;

const formatMonthName = (number: string) =>
  new Date(`2000-${number}-15T12:00:00`).toLocaleDateString('uk-UA', { month: 'short' }).replace('.', '');

/**
 * Native month inputs render «----- --» in Chrome until a value is picked and ignore the app's
 * theme; this one shows a word, a year and twelve buttons.
 */
export const MonthPicker = ({
  label,
  value,
  onChange,
  placeholder = 'будь-який',
  showLabel = true,
}: {
  label: string;
  /** In a row of unlabeled selects the label stays for screen readers only, and the placeholder says it. */
  showLabel?: boolean;
  value: Month | '';
  onChange: (month: Month | '') => void;
  placeholder?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number((value || findCurrentMonth()).slice(0, 4)));
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: MouseEvent | KeyboardEvent) => {
      const outside = event.target instanceof Node && ref.current?.contains(event.target) !== true;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : outside) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const pick = (month: Month | '') => {
    onChange(month);
    setOpen(false);
  };
  const thisYear = Number(findCurrentMonth().slice(0, 4));

  return (
    <div className="month-picker" ref={ref}>
      {showLabel && <span className="small muted">{label}</span>}
      <div className="mp-field">
        <button
          type="button"
          className={value === '' ? 'mp-trigger empty' : 'mp-trigger'}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}: ${value === '' ? placeholder : formatMonthShort(value)}`}
          onClick={() => {
            setYear(Number((value || findCurrentMonth()).slice(0, 4)));
            setOpen(!open);
          }}
        >
          {value === '' ? placeholder : formatMonthShort(value)}
        </button>
        {value !== '' && (
          <button type="button" className="mp-clear" aria-label={`Прибрати: ${label}`} onClick={() => pick('')}>
            ✕
          </button>
        )}
      </div>
      {open && (
        <div className="mp-pop" role="dialog" aria-label={label}>
          <div className="mp-year">
            <button type="button" className="btn small" aria-label="Попередній рік" onClick={() => setYear(year - 1)}>
              ‹
            </button>
            <b className="num">{year}</b>
            <button
              type="button"
              className="btn small"
              aria-label="Наступний рік"
              disabled={year >= thisYear}
              onClick={() => setYear(year + 1)}
            >
              ›
            </button>
          </div>
          <div className="mp-grid">
            {MONTH_NUMBERS.map((number) => {
              const month = `${year}-${number}`;
              return (
                <button
                  key={number}
                  type="button"
                  aria-pressed={month === value}
                  disabled={month > findCurrentMonth()}
                  onClick={() => pick(month)}
                >
                  {formatMonthName(number)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
