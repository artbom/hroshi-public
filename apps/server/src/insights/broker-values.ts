import { type BrokerSeries, type DatedValue, shiftDate, toAccountCurrency } from '@hroshi/domain';
import type { BrokerReport } from '@hroshi/schema';

import { loadBrokerReports } from '../brokers/reports.ts';
import type { Ledger } from '../ledger.ts';

/**
 * A statement without a value history whose deposits explain its value to within this share is
 * taken to list the account from its first deposit, so the account held nothing the day before.
 */
const MAX_UNEXPLAINED_SHARE = 0.5;

const byDate = (left: DatedValue, right: DatedValue) => left.date.localeCompare(right.date);

/** Every value the statement states, oldest first; the closing figure wins over a NAV row of the same day. */
const listStatedValues = (report: BrokerReport): DatedValue[] => {
  const stated = new Map(report.navHistory.map((point) => [point.date, point.value]));
  if (report.netAssets !== null) stated.set(report.asOf, report.netAssets);
  return [...stated].map(([date, value]) => ({ date, value })).toSorted(byDate);
};

const findEmptyStart = ({ report, deposits }: { report: BrokerReport; deposits: readonly DatedValue[] }): DatedValue | null => {
  const [first] = deposits;
  if (report.navHistory.length > 0 || report.netAssets === null || first === undefined) return null;
  const net = deposits.reduce((sum, deposit) => sum + deposit.value, 0);
  return net > 0 && Math.abs(report.netAssets - net) <= MAX_UNEXPLAINED_SHARE * net ? { date: shiftDate(first.date, -1), value: 0 } : null;
};

/** What each broker's latest statement knows about its tracker account: values by day and the deposits it lists. */
export const listBrokerSeries = async (ledger: Ledger): Promise<BrokerSeries[]> => {
  const reports = await loadBrokerReports();
  return [...reports].flatMap(([accountId, report]) => {
    const account = ledger.accounts.find((candidate) => candidate.id === accountId);
    if (account === undefined || report.currency !== account.currency) return [];
    const deposits = toAccountCurrency({
      flows: report.cashFlows.filter((flow) => flow.kind === 'deposit' || flow.kind === 'withdrawal'),
      currency: account.currency,
      fx: ledger.fx,
    })
      .map((flow) => ({ date: flow.date, value: flow.converted }))
      .toSorted(byDate);
    const start = findEmptyStart({ report, deposits });
    const values = [...(start === null ? [] : [start]), ...listStatedValues(report)];
    return values.length === 0 ? [] : [{ accountId, values, deposits }];
  });
};
