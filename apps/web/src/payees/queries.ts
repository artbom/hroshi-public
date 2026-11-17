import { PayeeDirectorySchema, type SavePayeeAliases, SavedPayeeAliasesSchema } from '@hroshi/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { requestJson } from '../api.ts';

export const usePayeeDirectory = () =>
  useQuery({ queryKey: ['payee-directory'], queryFn: () => requestJson({ path: '/payees/directory', schema: PayeeDirectorySchema }) });

/** A rename regroups rows everywhere (payees, recurring, review, operations), so every view refreshes. */
export const useSavePayeeAliases = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SavePayeeAliases) =>
      requestJson({ path: '/payee-aliases', method: 'PUT', body: input, schema: SavedPayeeAliasesSchema }),
    onSuccess: () => client.invalidateQueries(),
  });
};
