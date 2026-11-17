import { type Month, TripReportSchema } from '@hroshi/schema';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { buildQuery, requestJson } from '../api.ts';

/** Trips and tags that touch the period, with the period's travel spending outside them. */
export const useTrips = ({ from, to }: { from: Month; to: Month }) =>
  useQuery({
    queryKey: ['trips', from, to],
    queryFn: () => requestJson({ path: `/trips${buildQuery({ from, to })}`, schema: TripReportSchema }),
    placeholderData: keepPreviousData,
  });
