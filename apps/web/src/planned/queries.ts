import { type PlannedInput, PlannedOverrideSchema, QuickAddSchema } from '@hroshi/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { buildQuery, requestEmpty, requestJson } from '../api.ts';

export const useQuickAdd = () =>
  useQuery({ queryKey: ['quick-add'], queryFn: () => requestJson({ path: '/quick-add', schema: QuickAddSchema }) });

/** A planned payment moves the forecast, the expected list and the monthly sum: every view refreshes. */
const useRefreshAll = () => {
  const client = useQueryClient();
  return () => client.invalidateQueries();
};

export const useSavePlanned = () =>
  useMutation({
    mutationFn: (input: PlannedInput) => requestJson({ path: '/planned', method: 'PUT', body: input, schema: PlannedOverrideSchema }),
    onSuccess: useRefreshAll(),
  });

/** Back to what detection says. */
export const useResetPlanned = () =>
  useMutation({
    mutationFn: (key: string) => requestEmpty({ path: `/planned${buildQuery({ key })}`, method: 'DELETE' }),
    onSuccess: useRefreshAll(),
  });
