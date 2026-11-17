import type { CategoryDetail, Month, PayeeKind } from '@hroshi/schema';

import { type CategoryPolicies, classifyTransaction } from './classify.ts';
import { convertToEur, type FxConverter } from './fx.ts';
import { toMonth } from './months.ts';
import type { LedgerTransaction } from './types.ts';

const MERCHANT_KEY_LENGTH = 40;
const TOP_MERCHANTS = 8;
/** Mono books a released hold or a refund as "Скасування. <merchant>". */
const CANCELLATION_PREFIX = /^скасування\.?\s*/iu;
export const UNTITLED_MERCHANT = 'Без опису';

/** Who the money went to, as the owner would say it, and the key rows of that payee share. */
export type MerchantName = { key: string; name: string };

/** Revolut and Mono name the other side with a direction word in front; Mono sometimes spells «від» with a Latin «i». */
const DIRECTION_PREFIX = /^(?:в[іi]д:|to:?|from:?|bizum payment (?:to|from):)\s+/iu;
/** A store or terminal number glued onto the name: "SIXT9616309984", "ENI00947". */
const GLUED_NUMBER = /^(\p{L}{2,})\d{4,}$/u;
/** A trailing store, terminal or phone number: "AUTOS 157", "GUISSONA G056", "+380501234567". */
const TRAILING_NUMBER = /^(?:\p{L}?\d+|\+\d{6,})$/u;
const STAR_REFERENCE = /\*\S*\d\S*$/u;
const PHONE_SUFFIX = /\+\d{6,}$/u;
/** Mono describes a card-to-card payment by the recipient's masked number: 537541****1234. */
const MASKED_CARD = /^\d{4,6}\*{4,}(\d{4})$/u;
const TRAILING_NUMBER_NOISE = /[\s/\d.,*#-]+$/u;

const toTitleCase = (text: string) =>
  text
    .toLocaleLowerCase('uk')
    .split(' ')
    .map((word) => word.charAt(0).toLocaleUpperCase('uk') + word.slice(1))
    .join(' ');

export const toMerchantKey = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleUpperCase('uk')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Bank descriptors carry place, store and terminal noise ("SIXT9616309984,PAREDES,PT",
 * "CORP.ALIM.GUISSONA G056", "To Juan Garcia Lopez"); the payee is what is left.
 */
export const normalizeMerchant = (note: string | null): MerchantName => {
  const card = MASKED_CARD.exec(note?.trim() ?? '')?.[1];
  if (card !== undefined) return { key: `CARD ${card}`, name: `Картка •${card}` };
  const words = extractMerchant(note)
    .replace(DIRECTION_PREFIX, '')
    .split(',')[0]
    ?.replace(STAR_REFERENCE, '')
    .replace(PHONE_SUFFIX, '')
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(GLUED_NUMBER, '$1'));
  const kept = [...(words ?? [])];
  while (kept.length > 1 && TRAILING_NUMBER.test(kept.at(-1) ?? '')) kept.pop();
  const cleaned = kept.join(' ').trim() || UNTITLED_MERCHANT;
  const shouting = cleaned === cleaned.toLocaleUpperCase('uk') && /\p{L}{2}/u.test(cleaned);
  return { key: toMerchantKey(cleaned) || toMerchantKey(UNTITLED_MERCHANT), name: shouting ? toTitleCase(cleaned) : cleaned };
};

/** Bank wording that names the kind of payment, not who was paid. */
const GENERIC_PAYMENT = /^(?:щомісячний платіж|(?:повне |дострокове )?погашення|поповнення|переказ на картку|переказ між|розстрочка|оплата частинами)/iu;
/** Mono books each instalment as «Погашення наступного платежу <merchant>»: the merchant is the payee. */
const INSTALMENT_PREFIX = /^погашення наступного платежу\s*/iu;
const UNNAMED_KEY_PREFIX = 'БЕЗ НАЗВИ ';
/** Treasury accounts end in a budget code and a city: «ГУК у м.Києві/м.Київ/11011700». */
const BUDGET_CODE_SUFFIX = /(?:\/[^/]*\d{5,}[^/]*|\/м\.\s?київ)+$/iu;

/** A payee as lists show it; `unnamed` when the bank gave no one to name, so the row stands for its category. */
export type PayeeName = MerchantName & { unnamed: boolean };

/**
 * Who a row paid, never a bank phrase: «Погашення наступного платежу L.A.B.A» is L.A.B.A, while
 * «Щомісячний платіж», «Без опису» or a masked card number fold into «<category> · без назви».
 * A named payee keeps the key `normalizeMerchant` gives the whole bank text, which the
 * operations filter matches on.
 */
export const describePayee = ({ text, category }: { text: string | null; category: string }): PayeeName => {
  const raw = text?.trim() ?? '';
  const stripped = raw.replace(INSTALMENT_PREFIX, '');
  const named = normalizeMerchant(stripped === '' ? null : stripped);
  const unnamed =
    named.key === toMerchantKey(UNTITLED_MERCHANT) || MASKED_CARD.test(stripped) || GENERIC_PAYMENT.test(stripped);
  if (unnamed) return { key: `${UNNAMED_KEY_PREFIX}${toMerchantKey(category)}`, name: category, unnamed: true };
  return { key: normalizeMerchant(text).key, name: named.name.replace(BUDGET_CODE_SUFFIX, ''), unnamed: false };
};

/**
 * Text a rule can match the bank line on: the clean payee name when the bank spells it that
 * way («Sixt» in "SIXT9616309984,PAREDES,PT"), else the bank's own leading words.
 */
export const suggestRulePattern = (note: string | null): string => {
  const text = note?.trim() ?? '';
  if (MASKED_CARD.test(text)) return text;
  const { name } = normalizeMerchant(note);
  const candidate = text.toLocaleLowerCase('uk').includes(name.toLocaleLowerCase('uk'))
    ? name
    : (extractMerchant(note).split(',')[0]?.trim() ?? name);
  // A cut-off store or office number would stop the pattern matching the full one.
  return candidate.replace(TRAILING_NUMBER_NOISE, '') || candidate;
};

type PayeeSource = { note: string | null; bankText?: string | null; payee?: string | undefined };

/**
 * The owner's name for the payee (Дані → Отримувачі) wins; then the bank's own name over a note
 * the owner rewrote ("Apple" for "Apple.com/bill").
 */
export const findPayeeText = (transaction: PayeeSource): string | null =>
  transaction.payee ?? transaction.bankText ?? transaction.note;

/** What the bank line itself says, before any rename: rules match this text, never the owner's name for it. */
export const findBankText = (transaction: PayeeSource): string | null => transaction.bankText ?? transaction.note;

/**
 * Renamed and merged payees, by the key of the bank's spelling: every row whose spelling has a name
 * reads as that name, so payees that share a name group together everywhere.
 */
export const applyPayeeAliases = <T extends PayeeSource>({
  transactions,
  names,
}: {
  transactions: readonly T[];
  names: ReadonlyMap<string, string>;
}): T[] => {
  if (names.size === 0) return [...transactions];
  const keys = new Map<string | null, string>();
  return transactions.map((transaction) => {
    const text = findBankText(transaction);
    const key = keys.get(text) ?? normalizeMerchant(text).key;
    keys.set(text, key);
    const payee = names.get(key);
    return payee === undefined ? transaction : { ...transaction, payee };
  });
};

/** `\b` only knows Latin letters; these edges also hold around Cyrillic words. */
const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';
const matchWords = (words: string) => new RegExp(`${WORD_START}(?:${words})${WORD_END}`, 'iu');

const CASH_WITHDRAWAL = matchWords('банкомат|atm|cajero|geldautomat|cash withdrawal|зняття готівки|видача готівки');
const TAX_OFFICE = /^г?ук у(?:\s|$)|податков|казначейств|hacienda|agencia tributaria/iu;
const TAX_WORDS = matchWords('дпс|tax office');
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * The owner's own name as the whole payee: money between their own accounts in other banks.
 * Banks write it in either alphabet and order, so OWNER_NAMES lists every spelling
 * ("Ivan Petrenko, Іван Петренко") and each one matches both ways round. Anchored, because the
 * name also appears as the sender inside rent and SWIFT texts.
 */
const createOwnNamePattern = (names: string | undefined): RegExp | null => {
  const variants = (names ?? '')
    .split(',')
    .map((name) => name.trim().split(/\s+/u).filter(Boolean).map(escapeRegExp))
    .filter((words) => words.length > 0)
    .flatMap((words) => [words.join('\\s+'), words.toReversed().join('\\s+')]);
  return variants.length === 0 ? null : new RegExp(`^(?:mono\\*)?(?:${variants.join('|')})${WORD_END}`, 'iu');
};

const OWN_NAME = createOwnNamePattern(process.env['OWNER_NAMES']);
/** A payout from one of the owner's own Mono jars. */
const OWN_JAR = /^(?:виплата|часткове зняття|зняття)\s+банки\s+«/iu;
const PERSON_TRANSFER_MCC = 4829;
/** A company paid or paying through a bank transfer reads like a person («Від: Acme LLC») but is not one. */
const COMPANY = new RegExp(`${WORD_START}(?:llc|ltd|limited|inc|corp|gmbh|s\\.?l\\.?u?|b\\.?v|s\\.?a|ag|тов|пат|ат|банк)${WORD_END}|["«]`, 'iu');

/**
 * What kind of counterparty a bank text names. The owner's name and jars are checked before the
 * person-transfer MCC, because Mono books a transfer to their own card in another bank like any other.
 */
export const detectPayeeKind = ({ text, mcc }: { text: string | null; mcc: number | null }): PayeeKind => {
  const raw = text?.trim() ?? '';
  if (OWN_NAME?.test(raw.replace(DIRECTION_PREFIX, '')) || OWN_JAR.test(raw)) return 'own';
  if (CASH_WITHDRAWAL.test(raw)) return 'cash';
  const named = raw.replace(DIRECTION_PREFIX, '');
  if (TAX_OFFICE.test(named) || TAX_WORDS.test(named)) return 'tax';
  if (COMPANY.test(raw)) return 'merchant';
  if (mcc === PERSON_TRANSFER_MCC || DIRECTION_PREFIX.test(raw) || /^bizum\b/iu.test(raw)) return 'person';
  return 'merchant';
};

/** Notes look like "Glovo · order 123" or "Mercadona (Gràcia)"; the merchant is the leading part. */
export const extractMerchant = (note: string | null): string =>
  (note ?? UNTITLED_MERCHANT)
    .replace(CANCELLATION_PREFIX, '')
    .split(' · ')[0]
    ?.replace(/\s*\(.*\)$/, '')
    .trim()
    .slice(0, MERCHANT_KEY_LENGTH) || UNTITLED_MERCHANT;

/**
 * Where a category's money went, net of refunds: a car-rental hold and its cancellation
 * cancel out instead of showing the hold as the biggest merchant.
 */
export const rankMerchants = ({
  category,
  months,
  transactions,
  policies,
  fx,
}: {
  category: string;
  months: readonly Month[];
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
}): CategoryDetail['merchants'] => {
  const inRange = new Set(months);
  const totals = new Map<string, { merchant: string; eur: number; key: string; unnamed: boolean; count: number }>();

  for (const transaction of transactions) {
    if (transaction.category !== category || !inRange.has(toMonth(transaction.date))) continue;
    const effect = classifyTransaction(transaction, policies);
    if (effect.kind !== 'spend') continue;
    const eur = convertToEur({ transaction, fx });
    if (eur === null) continue;
    const { key, name, unnamed } = describePayee({ text: findPayeeText(transaction), category });
    const total = totals.get(key) ?? { merchant: name, eur: 0, key, unnamed, count: 0 };
    totals.set(key, { ...total, eur: total.eur + effect.sign * eur, count: total.count + 1 });
  }

  return [...totals.values()]
    .filter(({ eur }) => eur >= 0.5)
    .toSorted((left, right) => right.eur - left.eur)
    .slice(0, TOP_MERCHANTS)
    .map(({ unnamed, count, ...merchant }) => (unnamed ? { ...merchant, unnamed, count } : merchant));
};
