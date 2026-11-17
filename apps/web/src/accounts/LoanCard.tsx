import type { Loan } from '@hroshi/schema';

import { AccountMark } from '../components/SourceMark.tsx';
import { formatAccountName, formatDay, formatEurApprox, formatMoney, keepTogether, pluralize } from '../format.ts';
import { buildHref } from '../route.ts';
import { TransactionLine } from '../transactions/TransactionLine.tsx';
import { findDue, findLastRepayment } from './loans.ts';

const describeAge = (days: number) =>
  days < 60 ? pluralize(days, ['день', 'дні', 'днів']) : pluralize(Math.round(days / 30.4), ['місяць', 'місяці', 'місяців']);

/** Money lent to someone, or owed: when it left, how much, how much came back. */
export const LoanCard = ({ loan, names }: { loan: Loan; names: ReadonlyMap<string, string> }) => {
  const { account } = loan;
  const owe = account.balance < 0;
  const due = findDue(account);
  const lastRepayment = findLastRepayment(loan);
  return (
    <div className="card">
      <div className="head">
        <div>
          <div className="t with-mark tight">
            <AccountMark account={account} size="sm" />
            <a className="plain" href={buildHref({ view: 'accounts', param: account.id })}>
              {formatAccountName(account.name)}
            </a>
          </div>
          <div className="s">
            {account.counterparty === null ? (
              <span className="chip warn">хто — не вказано</span>
            ) : (
              keepTogether([account.counterparty, account.note].filter(Boolean).join(' · '))
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className={owe ? 'num neg' : 'num'} style={{ fontWeight: 600, fontSize: 18 }}>
            {formatMoney(account.balance, account.currency)}
          </div>
          {loan.eur !== null && account.currency !== 'EUR' && <div className="small muted num">≈&nbsp;{formatEurApprox(loan.eur)}</div>}
        </div>
      </div>
      <dl className="facts">
        <dt>{loan.sentRecorded ? (owe ? 'Борг з' : 'Гроші пішли') : 'В обліку з'}</dt>
        <dd>
          {formatDay(loan.sentDate)} · {describeAge(loan.ageDays)} тому
        </dd>
        <dt>{owe ? 'Винен усього' : 'Позичено'}</dt>
        <dd className="num">{formatMoney(loan.lent, account.currency)}</dd>
        <dt>Повернуто</dt>
        <dd className="num">
          {formatMoney(loan.repaid, account.currency)}
          {lastRepayment !== undefined && <span className="muted"> · востаннє {formatDay(lastRepayment.date)}</span>}
        </dd>
        {account.dueDate !== null && (
          <>
            <dt>Повернути до</dt>
            <dd>
              {formatDay(account.dueDate)}
              {due !== null && due.overdueDays > 0 && (
                <span className="chip warn"> прострочено {pluralize(due.overdueDays, ['день', 'дні', 'днів'])}</span>
              )}
            </dd>
          </>
        )}
      </dl>
      {!loan.sentRecorded && (
        <p className="note">Самого переказу в записах немає, тож дата — коли рахунок з’явився в трекері.</p>
      )}
      {loan.rows.length > 0 && (
        <div>
          {loan.rows.slice(0, 5).map((row) => (
            <TransactionLine key={row.id} transaction={row} accountNames={names} />
          ))}
        </div>
      )}
    </div>
  );
};
