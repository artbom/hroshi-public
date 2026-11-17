import type { InvestmentAccount, InvestmentFlow, TransactionRow, UnmatchedBrokerFlow } from '@hroshi/schema';
import { useEffect, useState } from 'react';

import { describeError } from '../api.ts';
import { useDrawer } from '../components/DrawerContext.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { formatAccountName, formatDay, formatMoney, formatSignedMoney, keepTogether, pluralize } from '../format.ts';
import { useUpdateTransaction } from '../queries.ts';
import { useContributionGaps } from './queries.ts';

type Names = ReadonlyMap<string, string>;

/** How long «Точно?» stays armed before the button falls back. */
const CONFIRM_MS = 3000;

/**
 * Turns a row into the deposit's bank side: a transfer into the broker account, credited with what
 * the broker booked. Two presses, because it rewrites a row the owner may have categorised on purpose.
 */
const LinkButton = ({ row, flow, account }: { row: TransactionRow; flow: UnmatchedBrokerFlow['flow']; account: InvestmentAccount['account'] }) => {
  const update = useUpdateTransaction();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  const name = formatAccountName(account.name);
  return (
    <>
      <button
        type="button"
        className={armed ? 'btn small primary' : 'btn small'}
        disabled={update.isPending}
        title={`Зробить запис переказом на ${name} із зарахуванням ${formatMoney(Math.abs(flow.amount), account.currency)}`}
        onClick={() => {
          if (!armed) {
            setArmed(true);
            return;
          }
          update.mutate({
            id: row.id,
            patch: { type: 'transfer', toAccountId: account.id, toAmount: Math.abs(flow.amount), category: null },
          });
        }}
      >
        {armed ? 'Точно пов’язати?' : `Це поповнення ${name}`}
      </button>
      {update.isError && <span className="note err">{describeError(update.error)}</span>}
    </>
  );
};

const CandidateRow = ({
  row,
  flow,
  account,
  names,
}: {
  row: TransactionRow;
  flow: UnmatchedBrokerFlow['flow'];
  account: InvestmentAccount['account'];
  names: Names;
}) => {
  const { openTransaction } = useDrawer();
  const kind = row.type === 'expense' ? `витрата «${row.category ?? 'Інше'}»` : row.type === 'income' ? 'дохід' : 'переказ';
  return (
    <div className="gap-candidate">
      <button type="button" className="link-button" onClick={() => openTransaction(row.id)}>
        {keepTogether(row.note ?? kind)}
      </button>
      <span className="num">{formatMoney(row.amount, row.currency)}</span>
      <span className="small muted">
        {formatDay(row.date)} · {names.get(row.accountId) ?? row.accountId}
        {row.toAccountId !== null && ` → ${names.get(row.toAccountId) ?? row.toAccountId}`} · {kind}
      </span>
      {/* A transfer between own accounts is already right about where the money went; only a mis-booked expense is relinked. */}
      {flow.kind === 'deposit' && row.type === 'expense' && (
        <span className="gap-actions">
          <LinkButton row={row} flow={flow} account={account} />
        </span>
      )}
    </div>
  );
};

const MissingFlow = ({ entry, account, names }: { entry: UnmatchedBrokerFlow; account: InvestmentAccount['account']; names: Names }) => {
  const { flow, candidates } = entry;
  return (
    <div className="gap-flow">
      <div className="pos-line">
        <b>
          {flow.kind === 'deposit' ? 'Поповнення' : 'Вивід'} {formatDay(flow.date)}
        </b>
        <span className={`num ${flow.amount < 0 ? 'neg' : 'pos'}`}>{formatSignedMoney(flow.amount, account.currency)}</span>
      </div>
      <div className="small muted">
        {flow.original !== null && `надіслано ${formatMoney(flow.original.amount, flow.original.currency)} · `}
        {keepTogether(flow.note ?? 'запис брокера')}
      </div>
      {candidates.length === 0 ? (
        <p className="note">Схожого запису в трекері немає: можливо, переказ ішов з рахунку, якого трекер не бачить.</p>
      ) : (
        <div className="gap-candidates">
          <div className="small muted">Схожі записи в трекері ({candidates.length}):</div>
          {candidates.map((row) => (
            <CandidateRow key={row.id} row={row} flow={flow} account={account} names={names} />
          ))}
        </div>
      )}
    </div>
  );
};

const ExtraFlow = ({ flow, currency, names }: { flow: InvestmentFlow; currency: string; names: Names }) => {
  const { openTransaction } = useDrawer();
  const counter = names.get(flow.counterAccountId) ?? flow.counterAccountId;
  return (
    <button type="button" className="row" onClick={() => openTransaction(flow.id)}>
      <span>
        {flow.direction === 'in' ? `з ${counter}` : `на ${counter}`}{' '}
        {flow.suspectedDuplicate && <span className="chip bad">можливий дубль</span>}
      </span>
      <span className={`r num ${flow.direction === 'in' ? 'pos' : 'neg'}`}>
        {flow.direction === 'in' ? '+' : '−'}
        {formatMoney(flow.amount ?? flow.estimate ?? 0, currency)}
      </span>
      <span className="s">
        {formatDay(flow.date)}
        {flow.counterCurrency !== currency && ` · ${formatMoney(flow.counterAmount, flow.counterCurrency)}`}
      </span>
    </button>
  );
};

/**
 * Where «бракує … проти брокера» comes from: each broker deposit with no transfer in the tracker,
 * next to rows that could be it, and the tracker's transfers the broker never booked.
 */
export const GapsSheet = ({ holding, names, onClose }: { holding: InvestmentAccount; names: Names; onClose: () => void }) => {
  const gaps = useContributionGaps(holding.account.id);
  const { account } = holding;
  const name = formatAccountName(account.name);
  return (
    <Sheet title={`${name}: внески брокера проти трекера`} subtitle="Лише перегляд: запис змінюється тільки кнопкою біля нього" onClose={onClose}>
      {gaps.isPending && <p className="note">Порівнюю…</p>}
      {gaps.isError && <p className="note err">{describeError(gaps.error)}</p>}
      {gaps.data !== undefined && (
        <div className="view gap-sheet">
          <dl className="facts">
            <dt>За брокером</dt>
            <dd className="num">{formatMoney(gaps.data.brokerNet, account.currency)}</dd>
            <dt>У трекері</dt>
            <dd className="num">{formatMoney(gaps.data.trackerNet, account.currency)}</dd>
            <dt>Різниця</dt>
            <dd className="num">{formatSignedMoney(gaps.data.brokerNet - gaps.data.trackerNet, account.currency)}</dd>
            <dt>Збігаються</dt>
            <dd>{pluralize(gaps.data.matched, ['пара', 'пари', 'пар'])}</dd>
          </dl>
          <section>
            <h2>Є у брокера, немає в трекері · {gaps.data.missing.length}</h2>
            {gaps.data.missing.length === 0 ? (
              <p className="note">Кожне поповнення брокера має переказ у трекері.</p>
            ) : (
              gaps.data.missing.map((entry) => (
                <MissingFlow key={`${entry.flow.date}-${entry.flow.amount}`} entry={entry} account={account} names={names} />
              ))
            )}
          </section>
          <section>
            <h2>Є в трекері, немає у брокера · {gaps.data.extra.length}</h2>
            {gaps.data.extra.length === 0 ? (
              <p className="note">Кожен переказ трекера є і в записах брокера.</p>
            ) : (
              <div className="list">
                {gaps.data.extra.map((flow) => (
                  <ExtraFlow key={flow.id} flow={flow} currency={account.currency} names={names} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
};
