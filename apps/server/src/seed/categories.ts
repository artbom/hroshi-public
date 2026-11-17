import type { Category } from '@hroshi/schema';

type CategorySeed = Omit<Category, 'order' | 'monthlyLimitEur' | 'archived' | 'parent'> & { archived?: boolean };

const expense = (name: string): CategorySeed => ({
  name,
  forExpense: true,
  forIncome: false,
  incomeRole: 'netting',
  countsAsSpending: true,
});

const income = (name: string, incomeRole: Category['incomeRole']): CategorySeed => ({
  name,
  forExpense: false,
  forIncome: true,
  incomeRole,
  countsAsSpending: true,
});

export const CATEGORY_SEEDS: readonly CategorySeed[] = [
  expense('Продукти'),
  expense('Кафе і ресторани'),
  expense('Житло'),
  expense("Комуналка і зв'язок"),
  expense('Транспорт'),
  expense('Авто'),
  expense('Підписки'),
  expense('Спорт'),
  expense("Здоров'я"),
  expense('Особистий догляд'),
  expense('Подорожі'),
  expense('Покупки'),
  expense('Одяг'),
  expense('Техніка'),
  expense('Розваги'),
  expense('Кофішоп'),
  expense('Послуги'),
  expense('Освіта'),
  expense('Подарунки'),
  expense('Благодійність'),
  expense('Податки і збори'),
  /** Expense «Інше» is spending; income «Інше» is usually an own transfer and is ignored. */
  { ...expense('Інше'), forIncome: true, incomeRole: 'ignored' },
  income('Зарплата/клієнт', 'earning'),
  income('Підробіток', 'earning'),
  income('Продаж речей', 'earning'),
  income('Повернення', 'refund'),
  /** ZenMoney-era categories that only history rows use. */
  { ...expense('Інвестиції'), countsAsSpending: false, incomeRole: 'ignored', archived: true },
  { ...expense('Без категорії'), archived: true },
];
