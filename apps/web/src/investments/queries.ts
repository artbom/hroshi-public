import { ContributionGapsSchema, PositionDetailSchema } from '@hroshi/schema';
import { useQuery } from '@tanstack/react-query';

import { requestJson } from '../api.ts';

/** One position with everything its statements say; only fetched while its drawer is open. */
export const usePositionDetail = (key: string | null) =>
  useQuery({
    queryKey: ['investments', 'position', key],
    queryFn: () => requestJson({ path: `/investments/positions/${encodeURIComponent(key ?? '')}`, schema: PositionDetailSchema }),
    enabled: key !== null,
  });

/** The broker's deposits against the tracker's transfers; only fetched while the gap sheet is open. */
export const useContributionGaps = (accountId: string | null) =>
  useQuery({
    queryKey: ['investments', 'gaps', accountId],
    queryFn: () => requestJson({ path: `/investments/gaps/${encodeURIComponent(accountId ?? '')}`, schema: ContributionGapsSchema }),
    enabled: accountId !== null,
  });
