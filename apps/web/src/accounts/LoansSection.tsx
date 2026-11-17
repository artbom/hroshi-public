import { SectionHead } from '../components/InfoTip.tsx';
import { formatAccountName, formatDay, formatEurApprox, formatMoney, keepTogether, pluralize } from '../format.ts';
import { useInvestments } from '../queries.ts';
import { buildHref } from '../route.ts';
import { findDue, findLastRepayment } from './loans.ts';

/** Інвестиції → «Позики»: money lent to people and owed to them, with who, when it is due and the last repayment. */
export const LoansSection = () => {
  const investments = useInvestments();
  const loans = [...(investments.data?.loans ?? []), ...(investments.data?.debts ?? [])].filter((loan) => !loan.account.archived);
  if (loans.length === 0) return null;
  return (
    <section>
      <SectionHead
        title="Позики"
        info={
          <p>
            Гроші, позичені людям (плюс), і борги їм (мінус). Хто і до коли — на сторінці позики; повернення — перекази з позики на
            твій рахунок.
          </p>
        }
      />
      <div className="loan-list">
        {loans.map((loan) => {
          const { account } = loan;
          const due = findDue(account);
          const last = findLastRepayment(loan);
          return (
            <a key={account.id} className="loan-row" href={buildHref({ view: 'accounts', param: account.id })}>
              <span className="loan-who">
                <b>{keepTogether(account.counterparty ?? formatAccountName(account.name))}</b>
                <span className="small muted">
                  {account.counterparty === null ? 'хто — не вказано' : formatAccountName(account.name)} ·{' '}
                  {last === undefined ? 'повернень ще не було' : `повернення ${formatDay(last.date)}`}
                </span>
              </span>
              <span className="loan-due small">
                {account.dueDate === null ? (
                  <span className="muted">без строку</span>
                ) : due !== null && due.overdueDays > 0 ? (
                  <span className="chip warn">прострочено {pluralize(due.overdueDays, ['день', 'дні', 'днів'])}</span>
                ) : (
                  <span className="muted">до {formatDay(account.dueDate)}</span>
                )}
              </span>
              <span className="loan-sum">
                <span className={account.balance < 0 ? 'num neg' : 'num'}>{formatMoney(account.balance, account.currency)}</span>
                {loan.eur !== null && account.currency !== 'EUR' && <span className="small muted num">≈&nbsp;{formatEurApprox(loan.eur)}</span>}
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
};
