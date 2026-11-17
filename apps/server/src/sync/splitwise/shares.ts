import { type Currency, CurrencySchema } from '@hroshi/schema';

import { roundMoney } from '../statement.ts';
import type { SplitwiseExpense, SplitwiseUser } from './client.ts';

/**
 * Splitwise's subcategories by the ledger category they mean. The owner's review settles the rest:
 * a Splitwise row without a match lands in the inbox like an unknown bank line.
 */
const CATEGORY_BY_SPLITWISE: Readonly<Record<string, string>> = {
  'Dining out': 'Кафе і ресторани',
  'Groceries': 'Продукти',
  'Liquor': 'Продукти',
  'Taxi': 'Транспорт',
  'Bus/train': 'Транспорт',
  'Parking': 'Авто',
  'Car': 'Авто',
  'Gas/fuel': 'Авто',
  'Hotel': 'Подорожі',
  'Plane': 'Подорожі',
  'Rent': 'Житло',
  'Mortgage': 'Житло',
  'Electricity': 'Комуналка і зв\'язок',
  'Heat/gas': 'Комуналка і зв\'язок',
  'Water': 'Комуналка і зв\'язок',
  'TV/Phone/Internet': 'Комуналка і зв\'язок',
  'Household supplies': 'Покупки',
  'Furniture': 'Покупки',
  'Electronics': 'Техніка',
  'Clothing': 'Одяг',
  'Gifts': 'Подарунки',
  'Medical expenses': 'Здоров\'я',
  'Sports': 'Спорт',
  'Games': 'Розваги',
  'Movies': 'Розваги',
  'Music': 'Розваги',
  'Education': 'Освіта',
  'Taxes': 'Податки і збори',
};

export const mapSplitwiseCategory = (name: string | undefined): string | undefined =>
  name === undefined ? undefined : CATEGORY_BY_SPLITWISE[name];

/**
 * What an expense means for the owner. `delta` is paid minus owed: positive, the others owe the
 * owner that much; negative, the owner owes it. A payment is a settle-up, money that moved for real.
 */
export type SplitwiseShare =
  | { kind: 'cost'; delta: number; paid: number; currency: Currency }
  | { kind: 'payment'; delta: number; currency: Currency; friend: SplitwiseUser | undefined }
  | { kind: 'foreign'; currency: string };

export const describeShare = ({ expense, me }: { expense: SplitwiseExpense; me: number }): SplitwiseShare | undefined => {
  const mine = expense.users.find((share) => share.user_id === me);
  if (mine === undefined) return undefined;
  const currency = CurrencySchema.safeParse(expense.currency_code);
  if (!currency.success) return { kind: 'foreign', currency: expense.currency_code };
  const delta = roundMoney(mine.paid_share - mine.owed_share);
  if (!expense.payment) return { kind: 'cost', delta, paid: roundMoney(mine.paid_share), currency: currency.data };
  const other = expense.users.find((share) => share.user_id !== me);
  return { kind: 'payment', delta, currency: currency.data, friend: other?.user ?? undefined };
};

export const describeUserName = (user: Pick<SplitwiseUser, 'first_name' | 'last_name'> | undefined) =>
  [user?.first_name, user?.last_name].filter(Boolean).join(' ') || 'хтось';

/** Equal shares to the cent; the cents that do not divide go to the first people listed. */
export const splitEvenly = ({ cost, count }: { cost: number; count: number }): number[] => {
  const cents = Math.round(cost * 100);
  const base = Math.floor(cents / count);
  return Array.from({ length: count }, (_, index) => (base + (index < cents - base * count ? 1 : 0)) / 100);
};
