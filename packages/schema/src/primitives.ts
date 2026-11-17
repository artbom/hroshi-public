import { z } from 'zod';

export const CurrencySchema = z.enum(['UAH', 'EUR', 'USD', 'USDT', 'GBP']);
export type Currency = z.infer<typeof CurrencySchema>;

export const AccountKindSchema = z.enum(['everyday', 'credit', 'cash', 'investment', 'receivable']);
export type AccountKind = z.infer<typeof AccountKindSchema>;

export const TransactionTypeSchema = z.enum(['expense', 'income', 'transfer', 'valuation']);
export type TransactionType = z.infer<typeof TransactionTypeSchema>;

export const IncomeRoleSchema = z.enum(['earning', 'refund', 'netting', 'ignored']);
export type IncomeRole = z.infer<typeof IncomeRoleSchema>;

export const SourceSchema = z.enum(['claude', 'page', 'mono', 'revolut', 'binance', 'ibkr', 'zenmoney', 'splitwise']);
export type Source = z.infer<typeof SourceSchema>;

export const SyncSourceSchema = SourceSchema.extract(['mono', 'revolut', 'binance', 'ibkr', 'splitwise']);
export type SyncSource = z.infer<typeof SyncSourceSchema>;

export const IsoDateSchema = z.iso.date();
export type IsoDate = z.infer<typeof IsoDateSchema>;

export const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected YYYY-MM');
export type Month = z.infer<typeof MonthSchema>;

export const PositiveAmountSchema = z.number().positive().finite();
