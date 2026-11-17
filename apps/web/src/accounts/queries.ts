import { AccountRecordPageSchema, AccountSchema, type UpdateLoan } from '@hroshi/schema';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { buildQuery, requestJson } from '../api.ts';

/** An account's statement, newest first, with the balance after every row. */
export const useAccountRecords = ({ id, limit }: { id: string; limit: number }) =>
  useQuery({
    queryKey: ['account-records', id, limit],
    queryFn: () =>
      requestJson({ path: `/accounts/${encodeURIComponent(id)}/records${buildQuery({ limit })}`, schema: AccountRecordPageSchema }),
    placeholderData: keepPreviousData,
  });

/** Who a loan is with and when it is due; accounts, loans and the account page all show it. */
export const useUpdateLoan = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLoan }) =>
      requestJson({ path: `/accounts/${encodeURIComponent(id)}/loan`, method: 'PATCH', body: patch, schema: AccountSchema }),
    onSuccess: () => client.invalidateQueries(),
  });
};
