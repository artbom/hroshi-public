import type { IsoDate, Month } from '@hroshi/schema';

/** How each currency is written beside an amount. ISO codes stay only in selects, where they disambiguate. */
const CURRENCY_SIGNS: ReadonlyMap<string, string> = new Map([
  ['UAH', 'грн'],
  ['EUR', '€'],
  ['USD', '$'],
  ['GBP', '£'],
  ['USDT', 'USDT'],
]);

export const formatCurrencySign = (currency: string): string => CURRENCY_SIGNS.get(currency) ?? currency;

/**
 * Groups of thousands are split by a no-break space, so «45 162» never wraps. Manrope draws it a
 * fifth of an em wide, a true thin space; its U+202F is half that and makes «1 350» read as «1350».
 */
const NBSP = '\u00a0';
const GROUP_SPACE = NBSP;
/** Between a number and its unit: a full no-break space. */
const UNIT_SPACE = NBSP;
const MINUS = '−';

const numberFormatters = new Map<string, Intl.NumberFormat>();

const findNumberFormatter = (minDigits: number, maxDigits: number): Intl.NumberFormat => {
  const key = `${minDigits}:${maxDigits}`;
  const cached = numberFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat('uk-UA', {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
    // A value that rounds to zero prints «0», not «−0».
    signDisplay: 'negative',
  });
  numberFormatters.set(key, formatter);
  return formatter;
};

/** The one way a number is printed: decimal comma, thin-space groups, a real minus sign. */
export const formatNumber = (value: number, { digits = 0, minDigits = digits }: { digits?: number; minDigits?: number } = {}): string =>
  findNumberFormatter(minDigits, digits)
    .formatToParts(value)
    .map((part) => (part.type === 'group' ? GROUP_SPACE : part.type === 'minusSign' ? MINUS : part.value))
    .join('');

const withUnit = (number: string, currency: string) => `${number}${UNIT_SPACE}${formatCurrencySign(currency)}`;

/** An amount with cents: «−1 800,50 €», «46,22 грн», «486,00 USDT». */
export const formatMoney = (value: number, currency: string): string => withUnit(formatNumber(value, { digits: 2 }), currency);

/** Money without the cents, for limits and other round figures. */
export const formatMoneyWhole = (value: number, currency: string): string =>
  withUnit(formatNumber(Math.round(value)), currency);

export const formatSignedMoney = (value: number, currency: string): string =>
  `${value < 0 ? MINUS : '+'}${formatMoney(Math.abs(value), currency)}`;

export const formatWhole = (value: number): string => formatNumber(Math.round(value));

/** A fraction with a decimal comma, never `toFixed`'s point: 125,04. */
export const formatDecimal = (value: number, digits = 1): string => formatNumber(value, { digits });

/** Whole euros with an explicit minus, for tiles and tooltips. */
export const formatEur = (value: number): string => formatMoneyWhole(value, 'EUR');

/** Below this many euros a whole figure hides the amount: −13,02 грн would read «≈ 0 €». */
const CENTS_BELOW_EUR = 10;

/** Euros for a «≈ €» line: whole above ten, with cents below it («0,25 €»). */
export const formatEurApprox = (value: number): string =>
  Math.abs(value) < CENTS_BELOW_EUR ? formatMoney(value, 'EUR') : formatEur(value);

/** The sign follows the rounded figure: −0,3 € reads «0 €», never «−0 €». */
export const formatSignedEur = (value: number): string => {
  const rounded = Math.round(value);
  return rounded === 0 ? formatMoneyWhole(0, 'EUR') : `${rounded < 0 ? MINUS : '+'}${formatMoneyWhole(Math.abs(rounded), 'EUR')}`;
};

/**
 * An exchange rate always reads as the price of the dearer unit in the cheaper one, «46,22 грн/USDT»
 * or «1,0834 $/€», never as «0,02». `amount` of `currency` bought `toAmount` of `toCurrency`.
 */
export const formatExchangeRate = ({
  amount,
  currency,
  toAmount,
  toCurrency,
}: {
  amount: number;
  currency: string;
  toAmount: number;
  toCurrency: string;
}): string => {
  if (amount <= 0 || toAmount <= 0) return '—';
  const perTo = amount / toAmount;
  const [rate, cheap, dear] = perTo >= 1 ? [perTo, currency, toCurrency] : [1 / perTo, toCurrency, currency];
  return `${formatNumber(rate, { digits: rate < 10 ? 4 : 2, minDigits: 2 })}${UNIT_SPACE}${formatCurrencySign(cheap)}/${formatCurrencySign(dear)}`;
};

/** A stored rate (units of `currency` per 1 €) in the same notation: «51,36 грн/€», «1,1612 €/£». */
export const formatRatePerEur = ({ perEur, currency }: { perEur: number; currency: string }): string =>
  formatExchangeRate({ amount: perEur, currency, toAmount: 1, toCurrency: 'EUR' });

export const formatPercent = (share: number): string => `${formatNumber(Math.round(share * 100))}%`;

/** A yearly return with one decimal: +12,5%. */
export const formatSignedPercentPrecise = (share: number): string =>
  `${share < 0 ? MINUS : '+'}${formatDecimal(Math.abs(share) * 100)}%`;

/** Below ten percent a whole number hides the size of the move (−0,15% would read −0%). */
export const formatSignedPercent = (share: number): string => {
  const percent = Math.abs(share) * 100;
  const shown = percent < 10 ? formatNumber(percent, { digits: 1 }) : formatWhole(percent);
  return `${share < 0 ? MINUS : '+'}${shown}%`;
};

const pluralRules = new Intl.PluralRules('uk-UA');

/** Ukrainian needs three forms: 1 запис, 2 записи, 5 записів. */
export const pluralize = (count: number, [one, few, many]: readonly [string, string, string]): string => {
  const rule = pluralRules.select(Math.round(count));
  const word = rule === 'one' ? one : rule === 'few' ? few : many;
  return `${formatWhole(count)} ${word}`;
};

const toMonthDate = (month: Month): Date => new Date(`${month}-15T12:00:00`);

/**
 * Intl ends uk-UA dates with «р.», which doubles the full stop at the end of a sentence
 * («до 10 лист. 2026 р..») and adds nothing a four-digit year does not already say.
 */
const dropYearSuffix = (text: string): string => text.replace(/\s*р\.$/u, '');

/** Intl separates «10 лист. 2026» with ordinary spaces; a date must never break across lines. */
const glueSpaces = (text: string): string => text.replace(/\s/gu, NBSP);

export const formatMonthLong = (month: Month): string =>
  glueSpaces(dropYearSuffix(toMonthDate(month).toLocaleDateString('uk-UA', { month: 'long', year: 'numeric' })));

const formatMonthName = (date: Date): string => date.toLocaleDateString('uk-UA', { month: 'short' }).replace('.', '');

/** «лист 26»: the same label every chart axis and compact table uses. */
export const formatMonthShort = (month: Month): string => {
  const date = toMonthDate(month);
  return `${formatMonthName(date)}${NBSP}${String(date.getFullYear()).slice(2)}`;
};

/** Months a range touches span more than one year: then every tick carries its year, or «груд» could be either. */
export const spansYears = (months: readonly string[]): boolean => new Set(months.map((month) => month.slice(0, 4))).size > 1;

/** Axis tick: the bare month name inside one year, «груд 25» on a range that crosses a new year. */
export const formatMonthTick = (month: Month, { withYear }: { withYear: boolean }): string =>
  withYear ? formatMonthShort(month) : formatMonthName(toMonthDate(month));

export const formatDayHeading = (date: IsoDate): string =>
  glueSpaces(
    new Date(`${date}T12:00:00`).toLocaleDateString('uk-UA', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      ...(date.slice(0, 4) === String(new Date().getFullYear()) ? {} : { year: 'numeric' }),
    }),
  );

/** The one way a calendar day is written in prose: 10 лист. 2026. */
export const formatDay = (date: IsoDate): string =>
  glueSpaces(
    dropYearSuffix(
      new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' }),
    ),
  );

/** A day inside the running year without its year: «5 лист.», for axes and dense lists. */
export const formatDayNoYear = (date: IsoDate): string =>
  glueSpaces(new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }));

/** A narrow column's date: 10.11 this year, 10.11.25 before. */
export const formatDayShort = (date: IsoDate): string =>
  new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString('uk-UA', {
    day: '2-digit',
    month: '2-digit',
    ...(date.slice(0, 4) === String(new Date().getFullYear()) ? {} : { year: '2-digit' }),
  });

export const formatDateTime = (iso: string): string =>
  glueSpaces(new Date(iso).toLocaleString('uk-UA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }));

export const formatTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });

export const formatDate = (iso: string): string => formatDay(new Date(iso).toLocaleDateString('en-CA'));

/**
 * Some account names carry the hryvnia sign («Mono біла ₴») or «(борг)»; the amount beside them
 * already says «грн», and the credit card's debt is deliberate, so neither earns a place on every row.
 */
export const formatAccountName = (name: string): string =>
  name
    .replace(/\s*\(борг\)/u, '')
    .replace(/\s*₴(?=\s|$)/u, '')
    .trim();

/** The one name of the usual level a month is compared with, on every screen: «сер. 6 повних міс.». */
export const formatBaseline = (months: number): string => `сер. ${formatWhole(months)} повних міс.`;

const MONTH_STEMS = 'січ|лют|бер|квіт|трав|черв|лип|серп|вер|жовт|лист|груд';
const UNITS = '€|\\$|£|₴|грн|USDT|USD|EUR|UAH|GBP|%|тис\\.|млн|днів|дні|день|міс\\.|років|роки|рік|год|хв|шт|разів|рази|записів|записи|запис';

/**
 * Text that did not come from a formatter (bank descriptions, ZenMoney notes, the owner's own words,
 * stored warnings) still prints numbers and dates the way formatters do: «12 813,61 $», «~2 225»,
 * «31 жовт. 2026» and «5 лист., 11:27» each stay on one line.
 */
const KEEP_TOGETHER: readonly (readonly [RegExp, string])[] = [
  // Digit groups: «12 813,61», «2 225».
  [/(\d) (?=\d{3}(?!\d))/gu, `$1${NBSP}`],
  // A number and the unit after it: «23,5 €», «5 970 грн», «12 днів».
  [new RegExp(`(\\d) (?=(?:${UNITS})(?![\\p{L}]))`, 'gu'), `$1${NBSP}`],
  // A sign or currency before a number: «≈ 0,25», «~ 31», «$ 120».
  [/([≈~±€$£₴]) (?=\d)/gu, `$1${NBSP}`],
  // The day and its month: «31 жовт.», «5 лист.», «13 листопада».
  [new RegExp(`(\\d{1,2}) (?=(?:${MONTH_STEMS})\\p{L}*\\.?)`, 'gu'), `$1${NBSP}`],
  // The month and its year or time: «жовт. 2026», «лист., 11:27».
  [new RegExp(`((?:${MONTH_STEMS})\\p{L}*\\.?,?) (?=\\d{1,4}\\b)`, 'gu'), `$1${NBSP}`],
];

export const keepTogether = (text: string): string =>
  KEEP_TOGETHER.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);

const CURRENCY_CODES: ReadonlyMap<string, string> = new Map([
  ['₴', 'UAH'],
  ['грн', 'UAH'],
  ['UAH', 'UAH'],
  ['€', 'EUR'],
  ['EUR', 'EUR'],
  ['$', 'USD'],
  ['USD', 'USD'],
  ['USDT', 'USDT'],
]);

const CURRENCY_PATTERN = '₴|грн|UAH|€|EUR|\\$|USDT|USD';

/** «5970», «-58,1», «12.5» as a number; a decimal part keeps its cents in print. */
const formatRawAmount = ({ raw, currency }: { raw: string; currency: string | undefined }): string => {
  const value = Number(raw.replace(',', '.'));
  const hasCents = /[.,]\d/u.test(raw);
  if (currency === undefined) return formatNumber(value, { digits: hasCents ? 2 : 0 });
  return hasCents ? formatMoney(value, currency) : formatMoneyWhole(value, currency);
};

/**
 * Warnings are stored as text when a sync runs («2024-03-08 5970 ₴»); they are printed in the app's
 * own notation at display time («8 бер. 2024 · 5 970 грн»), so old stored warnings read right too.
 */
export const formatWarning = (text: string): string =>
  keepTogether(
    text
      .replace(
        new RegExp(`(\\d{4}-\\d{2}-\\d{2})(?:[ T](\\d{2}:\\d{2})(?::\\d{2})?)?(?:\\s+(-?\\d+(?:[.,]\\d+)?)\\s?(${CURRENCY_PATTERN})(?![\\p{L}]))?`, 'gu'),
        (_match, day: string, time: string | undefined, amount: string | undefined, sign: string | undefined) =>
          [
            `${formatDay(day)}${time === undefined ? '' : `, ${time}`}`,
            amount === undefined ? null : formatRawAmount({ raw: amount, currency: CURRENCY_CODES.get(sign ?? '') }),
          ]
            .filter((part) => part !== null)
            .join(' · '),
      )
      .replace(
        new RegExp(`(?<![\\d${NBSP}.,])(-?\\d+(?:[.,]\\d+)?)\\s?(${CURRENCY_PATTERN})(?![\\p{L}])`, 'gu'),
        (_match, amount: string, sign: string) => formatRawAmount({ raw: amount, currency: CURRENCY_CODES.get(sign) }),
      )
      .replace(/(^|[\s(])-(?=\d)/gu, `$1${MINUS}`),
  );
