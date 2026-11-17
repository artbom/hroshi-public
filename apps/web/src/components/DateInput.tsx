import { IsoDateSchema, type IsoDate } from '@hroshi/schema';
import { useEffect, useRef, useState } from 'react';

import { formatDay } from '../format.ts';
import { findToday } from '../months.ts';

const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'] as const;

/** «31.10.2026» for an ISO day; empty stays empty. */
const formatTyped = (value: IsoDate | '') => (value === '' ? '' : `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`);

/** «31.10.2026», «31.10.26» or «31/10/2026» as an ISO day, or null while the text is not a real date yet. */
const parseTyped = (text: string): IsoDate | null => {
  const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/u.exec(text.trim());
  if (match === null) return null;
  const [, day = '', month = '', rawYear = ''] = match;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const parsed = IsoDateSchema.safeParse(iso);
  // 31.02 parses as a string but rolls over in Date; only a day that exists counts.
  return parsed.success && new Date(`${iso}T12:00:00`).toISOString().slice(0, 10) === iso ? parsed.data : null;
};

const toIso = (date: Date): IsoDate =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** The days a month view shows, Monday first, with blanks before the 1st. */
const listMonthDays = ({ year, month }: { year: number; month: number }): (IsoDate | null)[] => {
  const first = new Date(year, month, 1, 12);
  const blanks = (first.getDay() + 6) % 7;
  const count = new Date(year, month + 1, 0, 12).getDate();
  return [
    ...Array.from({ length: blanks }, () => null),
    ...Array.from({ length: count }, (_, index) => toIso(new Date(year, month, index + 1, 12))),
  ];
};

const formatMonthTitle = ({ year, month }: { year: number; month: number }) =>
  new Date(year, month, 15, 12).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' }).replace(/\s*р\.$/u, '');

/**
 * A day field that reads Ukrainian whatever the browser's language: Chrome draws a native date
 * input in its own locale («dd.mm.yyyy»), so this one takes «дд.мм.рррр» and opens its own calendar.
 */
export const DateInput = ({
  value,
  onChange,
  label,
  required = false,
}: {
  value: IsoDate | '';
  onChange: (date: IsoDate | '') => void;
  /** For screen readers; the visible label stays with the form. */
  label: string;
  required?: boolean;
}) => {
  const [text, setText] = useState(formatTyped(value));
  const [shown, setShown] = useState(value);
  const [open, setOpen] = useState(false);
  const [today] = useState(findToday);
  const anchor = value === '' ? today : value;
  const [view, setView] = useState({ year: Number(anchor.slice(0, 4)), month: Number(anchor.slice(5, 7)) - 1 });
  const ref = useRef<HTMLDivElement>(null);

  // A value set from outside (a reset, another row) replaces what was typed.
  if (value !== shown) {
    setShown(value);
    setText(formatTyped(value));
  }

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

  const pick = (date: IsoDate) => {
    setShown(date);
    setText(formatTyped(date));
    onChange(date);
    setOpen(false);
  };
  const shift = (step: number) => {
    const next = new Date(view.year, view.month + step, 1, 12);
    setView({ year: next.getFullYear(), month: next.getMonth() });
  };
  const invalid = text.trim() !== '' && parseTyped(text) === null;

  return (
    <div className="date-input" ref={ref}>
      <div className="date-field">
        <input
          inputMode="numeric"
          placeholder="дд.мм.рррр"
          aria-label={label}
          aria-invalid={invalid || undefined}
          required={required}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = parseTyped(event.target.value);
            if (parsed !== null) {
              setShown(parsed);
              onChange(parsed);
            } else if (event.target.value.trim() === '') {
              setShown('');
              onChange('');
            }
          }}
        />
        <button
          type="button"
          className="date-open"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label}: календар`}
          onClick={() => {
            setView({ year: Number(anchor.slice(0, 4)), month: Number(anchor.slice(5, 7)) - 1 });
            setOpen(!open);
          }}
        >
          <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden="true">
            <path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" />
          </svg>
        </button>
      </div>
      {open && (
        <div className="date-pop" role="dialog" aria-label={label}>
          <div className="mp-year">
            <button type="button" className="btn small" aria-label="Попередній місяць" onClick={() => shift(-1)}>
              ‹
            </button>
            <b>{formatMonthTitle(view)}</b>
            <button type="button" className="btn small" aria-label="Наступний місяць" onClick={() => shift(1)}>
              ›
            </button>
          </div>
          <div className="date-grid">
            {WEEKDAYS.map((day) => (
              <span key={day} className="date-weekday">
                {day}
              </span>
            ))}
            {listMonthDays(view).map((day, index) =>
              day === null ? (
                <span key={`blank-${String(index)}`} />
              ) : (
                <button
                  key={day}
                  type="button"
                  aria-pressed={day === value}
                  aria-label={formatDay(day)}
                  className={day === today ? 'today' : undefined}
                  onClick={() => pick(day)}
                >
                  {Number(day.slice(8, 10))}
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
};
