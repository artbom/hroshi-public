import { SnoozedReviewSchema, type SnoozeReview } from '@hroshi/schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { requestJson } from '../api.ts';

/** Parks a group's rows for later, or brings them back; the inbox and its counts refresh. */
export const useSnoozeReview = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SnoozeReview) => requestJson({ path: '/review/snooze', method: 'POST', body: input, schema: SnoozedReviewSchema }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['review'] }),
  });
};
