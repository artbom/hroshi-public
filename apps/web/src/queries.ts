import {
  AccountHistorySchema,
  AccountListSchema,
  BudgetSchema,
  CategoryDetailSchema,
  CategoryListSchema,
  CategorySchema,
  CategoryUsageListSchema,
  ConsentStartSchema,
  type CreateCategory,
  CreatedTransactionSchema,
  type CreateTransaction,
  CurrentNetWorthSchema,
  DataQualitySchema,
  type FileImportRequest,
  FileImportResultSchema,
  HryvniaExposureSchema,
  InvestmentsSchema,
  type Month,
  MonthComparisonSchema,
  MonthOverviewSchema,
  NetWorthBridgeSchema,
  NetWorthHistorySchema,
  PayeesSchema,
  RecurringSchema,
  ReviewCountSchema,
  ReviewInboxSchema,
  type RuleInput,
  RuleListSchema,
  type RulePreviewInput,
  RulePreviewSchema,
  RuleSchema,
  RuleStatsSchema,
  type SplitTransaction,
  type SyncSource,
  SyncStatusListSchema,
  TagListSchema,
  TransactionExplainSchema,
  TransactionPageSchema,
  type TransactionQuery,
  TransactionSchema,
  TransactionSplitSchema,
  TrendsSchema,
  type SavingsGoal,
  type UpdateCategory,
  type UpdateTransaction,
} from '@hroshi/schema';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { buildQuery, requestEmpty, requestJson } from './api.ts';

/** Parsed query shape; anything left out takes the server default. */
export type TransactionFilter = Partial<TransactionQuery>;

/** While a run is in progress the status is polled at this pace. */
const SYNC_POLL_MS = 5000;

export const useAccounts = () =>
  useQuery({ queryKey: ['accounts'], queryFn: () => requestJson({ path: '/accounts', schema: AccountListSchema }) });

export const useCategories = () =>
  useQuery({
    queryKey: ['categories'],
    queryFn: () => requestJson({ path: '/categories', schema: CategoryListSchema }),
    staleTime: Infinity,
  });

export const useOverview = (month: Month) =>
  useQuery({
    queryKey: ['overview', month],
    queryFn: () => requestJson({ path: `/overview${buildQuery({ month })}`, schema: MonthOverviewSchema }),
    placeholderData: keepPreviousData,
  });

export const useNetWorth = () =>
  useQuery({ queryKey: ['net-worth'], queryFn: () => requestJson({ path: '/net-worth', schema: CurrentNetWorthSchema }) });

export const useTrends = ({ month, range, spreadTax = false }: { month: Month; range: number; spreadTax?: boolean }) =>
  useQuery({
    queryKey: ['trends', month, range, spreadTax],
    queryFn: () => requestJson({ path: `/trends${buildQuery({ month, range, spreadTax })}`, schema: TrendsSchema }),
    placeholderData: keepPreviousData,
  });

export const useCategoryDetail = ({
  month,
  range,
  category,
  spreadTax = false,
}: {
  month: Month;
  range: number;
  category: string | null;
  spreadTax?: boolean;
}) =>
  useQuery({
    queryKey: ['category-detail', month, range, category, spreadTax],
    queryFn: () =>
      requestJson({
        path: `/category-detail${buildQuery({ month, range, category, spreadTax })}`,
        schema: CategoryDetailSchema,
      }),
    enabled: category !== null,
    placeholderData: keepPreviousData,
  });

export const useAccountHistory = ({ id, months }: { id: string; months: number }) =>
  useQuery({
    queryKey: ['account-history', id, months],
    queryFn: () =>
      requestJson({ path: `/accounts/${encodeURIComponent(id)}/history${buildQuery({ months })}`, schema: AccountHistorySchema }),
  });

export const useNetWorthHistory = (months: number) =>
  useQuery({
    queryKey: ['net-worth-history', months],
    queryFn: () => requestJson({ path: `/net-worth/history${buildQuery({ months })}`, schema: NetWorthHistorySchema }),
    placeholderData: keepPreviousData,
  });

/** Why net worth moved from the end of the month before `from` to the end of `month`. */
export const useNetWorthBridge = ({ from, month }: { from: Month; month: Month }) =>
  useQuery({
    queryKey: ['net-worth-bridge', from, month],
    queryFn: () => requestJson({ path: `/net-worth/bridge${buildQuery({ month, from })}`, schema: NetWorthBridgeSchema }),
    placeholderData: keepPreviousData,
  });

export const useInvestments = () =>
  useQuery({ queryKey: ['investments'], queryFn: () => requestJson({ path: '/investments', schema: InvestmentsSchema }) });

export const usePayees = ({ from, to }: { from: Month; to: Month }) =>
  useQuery({
    queryKey: ['payees', from, to],
    queryFn: () => requestJson({ path: `/payees${buildQuery({ from, to })}`, schema: PayeesSchema }),
    placeholderData: keepPreviousData,
  });

export const useRecurring = () =>
  useQuery({ queryKey: ['recurring'], queryFn: () => requestJson({ path: '/recurring', schema: RecurringSchema }) });

export const useDataQuality = (months: number) =>
  useQuery({
    queryKey: ['data-quality', months],
    queryFn: () => requestJson({ path: `/data-quality${buildQuery({ months })}`, schema: DataQualitySchema }),
  });

export const useTags = () =>
  useQuery({ queryKey: ['tags'], queryFn: () => requestJson({ path: '/tags', schema: TagListSchema }) });

export const useComparison = (month: Month, { spreadTax = false }: { spreadTax?: boolean } = {}) =>
  useQuery({
    queryKey: ['compare', month, spreadTax],
    queryFn: () => requestJson({ path: `/compare${buildQuery({ month, spreadTax })}`, schema: MonthComparisonSchema }),
    placeholderData: keepPreviousData,
  });

export const useHryvniaExposure = (months: number) =>
  useQuery({
    queryKey: ['fx-hryvnia', months],
    queryFn: () => requestJson({ path: `/fx/hryvnia${buildQuery({ months })}`, schema: HryvniaExposureSchema }),
    placeholderData: keepPreviousData,
  });

export const useExplanation = (id: string | null) =>
  useQuery({
    queryKey: ['explain', id],
    queryFn: () =>
      requestJson({ path: `/transactions/${encodeURIComponent(id ?? '')}/explain`, schema: TransactionExplainSchema }),
    enabled: id !== null,
  });

export const useReviewInbox = () =>
  useQuery({ queryKey: ['review'], queryFn: () => requestJson({ path: '/review', schema: ReviewInboxSchema }) });

export const useTransactions = (query: TransactionFilter) =>
  useQuery({
    queryKey: ['transactions', query],
    queryFn: () => requestJson({ path: `/transactions${buildQuery(query)}`, schema: TransactionPageSchema }),
    placeholderData: keepPreviousData,
  });

/** Keyed under «transactions» so every edit that refreshes rows refreshes the badge too. */
export const useReviewCount = () =>
  useQuery({
    queryKey: ['transactions', 'review-count'],
    queryFn: () => requestJson({ path: '/review/count', schema: ReviewCountSchema }),
    select: (count) => count.waiting,
  });

export const useRules = () =>
  useQuery({ queryKey: ['rules'], queryFn: () => requestJson({ path: '/rules', schema: RuleListSchema }) });

export const useRuleStats = () =>
  useQuery({ queryKey: ['rule-stats'], queryFn: () => requestJson({ path: '/rules/stats', schema: RuleStatsSchema }) });

/** What a rule would catch, asked only once the pattern is long enough to mean something. */
export const useRulePreview = (input: RulePreviewInput | null) =>
  useQuery({
    queryKey: ['rule-preview', input],
    queryFn: () => requestJson({ path: '/rules/preview', method: 'POST', body: input, schema: RulePreviewSchema }),
    enabled: input !== null && (input.pattern !== null || input.mcc !== null),
    placeholderData: keepPreviousData,
  });

export const useSyncStatus = () =>
  useQuery({
    queryKey: ['sync'],
    queryFn: () => requestJson({ path: '/sync', schema: SyncStatusListSchema }),
    refetchInterval: (query) =>
      query.state.data?.some((status) => status.lastRun?.status === 'running') ? SYNC_POLL_MS : false,
  });

/** A single user's ledger is small; any write simply refreshes every view. */
const useRefreshAll = () => {
  const client = useQueryClient();
  return () => client.invalidateQueries();
};

export const useCreateTransaction = () =>
  useMutation({
    mutationFn: (input: CreateTransaction) =>
      requestJson({ path: '/transactions', method: 'POST', body: input, schema: CreatedTransactionSchema }),
    onSuccess: useRefreshAll(),
  });

export const useUpdateTransaction = () =>
  useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTransaction }) =>
      requestJson({ path: `/transactions/${encodeURIComponent(id)}`, method: 'PATCH', body: patch, schema: TransactionSchema }),
    onSuccess: useRefreshAll(),
  });

/** One answer for every row of a payee in the review inbox. */
export const useUpdateTransactions = () =>
  useMutation({
    mutationFn: async ({ ids, patch }: { ids: readonly string[]; patch: UpdateTransaction }) => {
      for (const id of ids) {
        await requestJson({ path: `/transactions/${encodeURIComponent(id)}`, method: 'PATCH', body: patch, schema: TransactionSchema });
      }
    },
    onSuccess: useRefreshAll(),
  });

/** Folds a bank line into the hand entry it duplicates, keeping the hand entry's category and note. */
export const useMergeTransaction = () =>
  useMutation({
    mutationFn: ({ id, intoId }: { id: string; intoId: string }) =>
      requestJson({
        path: `/transactions/${encodeURIComponent(id)}/merge`,
        method: 'POST',
        body: { intoId },
        schema: TransactionSchema,
      }),
    onSuccess: useRefreshAll(),
  });

/** Splits a row into parts with their own categories; called on a part, it re-splits the whole row. */
export const useSplitTransaction = () =>
  useMutation({
    mutationFn: ({ id, input }: { id: string; input: SplitTransaction }) =>
      requestJson({
        path: `/transactions/${encodeURIComponent(id)}/split`,
        method: 'PUT',
        body: input,
        schema: TransactionSplitSchema,
      }),
    onSuccess: useRefreshAll(),
  });

export const useUnsplitTransaction = () =>
  useMutation({
    mutationFn: (id: string) =>
      requestJson({ path: `/transactions/${encodeURIComponent(id)}/split`, method: 'DELETE', schema: TransactionSchema }),
    onSuccess: useRefreshAll(),
  });

export const useDeleteTransaction = () =>
  useMutation({
    mutationFn: (id: string) => requestEmpty({ path: `/transactions/${encodeURIComponent(id)}`, method: 'DELETE' }),
    onSuccess: useRefreshAll(),
  });

export const useSaveRule = () =>
  useMutation({
    mutationFn: ({ id, input }: { id: string | null; input: RuleInput }) =>
      requestJson({
        path: id === null ? '/rules' : `/rules/${encodeURIComponent(id)}`,
        method: id === null ? 'POST' : 'PUT',
        body: input,
        schema: RuleSchema,
      }),
    onSuccess: useRefreshAll(),
  });

export const useDeleteRule = () =>
  useMutation({
    mutationFn: (id: string) => requestEmpty({ path: `/rules/${encodeURIComponent(id)}`, method: 'DELETE' }),
    onSuccess: useRefreshAll(),
  });

export const useStartSync = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (source: SyncSource) => requestEmpty({ path: `/sync/${source}`, method: 'POST' }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['sync'] }),
  });
};

export const useStartRevolutConsent = () =>
  useMutation({
    mutationFn: () => requestJson({ path: '/connections/revolut/start', method: 'POST', schema: ConsentStartSchema }),
    onSuccess: ({ url }) => window.location.assign(url),
  });

export const useCategoryUsage = () =>
  useQuery({
    queryKey: ['category-usage'],
    queryFn: () => requestJson({ path: '/categories/usage', schema: CategoryUsageListSchema }),
  });

export const useCreateCategory = () =>
  useMutation({
    mutationFn: (input: CreateCategory) => requestJson({ path: '/categories', method: 'POST', body: input, schema: CategorySchema }),
    onSuccess: useRefreshAll(),
  });

export const useUpdateCategory = () =>
  useMutation({
    mutationFn: ({ name, patch }: { name: string; patch: UpdateCategory }) =>
      requestJson({ path: `/categories/${encodeURIComponent(name)}`, method: 'PATCH', body: patch, schema: CategorySchema }),
    onSuccess: useRefreshAll(),
  });

export const useBudget = () => useQuery({ queryKey: ['budget'], queryFn: () => requestJson({ path: '/budget', schema: BudgetSchema }) });

export const useSetSavingsGoal = () =>
  useMutation({
    mutationFn: (goal: SavingsGoal) => requestJson({ path: '/budget/goal', method: 'PUT', body: goal, schema: BudgetSchema }),
    onSuccess: useRefreshAll(),
  });

export const useSetCategoryLimit = () =>
  useMutation({
    mutationFn: ({ name, monthlyLimitEur }: { name: string; monthlyLimitEur: number | null }) =>
      requestJson({
        path: `/categories/${encodeURIComponent(name)}/limit`,
        method: 'PUT',
        body: { monthlyLimitEur },
        schema: CategorySchema,
      }),
    onSuccess: useRefreshAll(),
  });

/** One payee's answer in the review inbox: its rows get the patch, and a rule may follow for the next ones. */
export type ReviewAnswer = { ids: readonly string[]; patch: UpdateTransaction; rule: RuleInput | null };

/** Answers saved one row at a time through the ordinary endpoints, reporting how far it got. */
export const useAnswerReview = () =>
  useMutation({
    mutationFn: async ({ answers, onProgress }: { answers: readonly ReviewAnswer[]; onProgress?: (done: number) => void }) => {
      let done = 0;
      for (const { ids, patch, rule } of answers) {
        for (const id of ids) {
          await requestJson({ path: `/transactions/${encodeURIComponent(id)}`, method: 'PATCH', body: patch, schema: TransactionSchema });
        }
        if (rule !== null) await requestJson({ path: '/rules', method: 'POST', body: rule, schema: RuleSchema });
        done += 1;
        onProgress?.(done);
      }
    },
    onSuccess: useRefreshAll(),
  });

/** A dry run only reads, so only a real import refreshes the views. */
export const useImportFiles = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: FileImportRequest) =>
      requestJson({ path: '/import', method: 'POST', body: input, schema: FileImportResultSchema }),
    onSuccess: (result) => (result.dryRun ? undefined : client.invalidateQueries()),
  });
};
