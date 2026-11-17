import type { PlannedInput, RecurringPayment } from '@hroshi/schema';

/** The day a detected payment actually went out; the owner corrects it in the sheet if rent is due on another day. */
export const findPaymentDay = (payment: RecurringPayment): number => payment.dayOfMonth ?? Number(payment.lastDate.slice(8, 10));

/** Confirming as detected: the median amount, the day it was last paid, the account and category it used. */
export const buildConfirmedTerms = (payment: RecurringPayment): PlannedInput | null =>
  payment.accountId === '' || payment.category === ''
    ? null
    : {
        key: payment.key,
        status: 'confirmed',
        name: payment.name,
        amount: Math.round(payment.amount * 100) / 100,
        currency: payment.currency,
        dayOfMonth: findPaymentDay(payment),
        accountId: payment.accountId,
        category: payment.category,
      };

const rankPayment = (payment: RecurringPayment) => (payment.late ? 2 : payment.overdueDays > 0 ? 0 : 1);

/** Overdue first (the longest first), then by size; «пропущено?» ones, probably cancelled, last. */
export const sortPayments = (payments: readonly RecurringPayment[]): RecurringPayment[] =>
  payments.toSorted(
    (left, right) => rankPayment(left) - rankPayment(right) || right.overdueDays - left.overdueDays || right.eur - left.eur,
  );
