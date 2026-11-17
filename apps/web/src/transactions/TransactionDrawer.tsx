import {
  type AccountBalance,
  type BankCheck,
  type BankLine,
  type Category,
  type Classification,
  ESTIMATE_MARKER,
  type RateUsage,
  type TransactionExplain,
  type UpdateTransaction,
} from '@hroshi/schema';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { describeError } from '../api.ts';
import { useDrawer } from '../components/DrawerContext.tsx';
import {
  formatAccountName,
  formatDateTime,
  formatDay,
  formatDayNoYear,
  formatEurApprox,
  formatExchangeRate,
  formatMoney,
  formatNumber,
  formatRatePerEur,
  formatSignedMoney,
  keepTogether,
  pluralize,
} from '../format.ts';
import {
  useAccounts,
  useCategories,
  useDeleteTransaction,
  useExplanation,
  useMergeTransaction,
  useSaveRule,
  useSplitTransaction,
  useUnsplitTransaction,
  useUpdateTransaction,
} from '../queries.ts';
import { DateInput } from '../components/DateInput.tsx';
import { SourceMark } from '../components/SourceMark.tsx';
import { buildHref, buildTableHref } from '../route.ts';
import { DeleteButton, describeLine, isEstimated, TransactionLine, UNNAMED_TRANSFER } from './TransactionLine.tsx';

const SOURCE_LABELS: Readonly<Record<TransactionExplain['origin']['source'], string>> = {
  claude: 'внесено через Claude',
  page: 'внесено вручну на сторінці',
  mono: 'Monobank',
  revolut: 'Revolut (Enable Banking)',
  binance: 'Binance',
  ibkr: 'Interactive Brokers',
  zenmoney: 'імпорт з ZenMoney',
  splitwise: 'Splitwise',
};

const parseAmount = (value: string): number => Number(value.replace(',', '.').replace(/\s/g, ''));

/** Amounts typed into inputs use the decimal comma the rest of the page shows: 683,26. */
const toInputAmount = (value: number): string => String(value).replace('.', ',');

const describeEffect = ({ explain }: { explain: TransactionExplain }): string => {
  const { effect } = explain.classification;
  const { transaction } = explain;
  const eur = transaction.eur === null ? '' : ` (≈\u00a0${formatEurApprox(Math.abs(transaction.eur))})`;
  switch (effect.kind) {
    case 'spend':
      return effect.sign === 1
        ? `Витрата в категорії «${effect.category}»: додається до витрат місяця${eur}.`
        : `Повернення в категорію «${effect.category}»: зменшує її витрати${eur}, а не рахується доходом.`;
    case 'income':
      return `Дохід «${transaction.category ?? ''}»: рахується в доходах місяця${eur}.`;
    case 'refund':
      return `Загальне повернення: зменшує всі витрати місяця${eur}.`;
    case 'none':
      if (transaction.type === 'transfer') return 'Переказ між своїми рахунками: не витрата і не дохід, рухає лише баланси.';
      if (transaction.type === 'valuation') return 'Переоцінка: ринкова зміна вартості. Не дохід і не витрата.';
      if (transaction.type === 'income') {
        return `Дохід «${transaction.category ?? 'Інше'}» не рахується ні в доходах, ні у витратах: найчастіше це свій переказ.`;
      }
      return `Категорія «${transaction.category ?? ''}» не рахується як витрата.`;
  }
};

/** The row's own share of a chain, so it never reads as if the whole amount stayed in the month. */
const describeOwnShare = ({ explain }: { explain: TransactionExplain }): string => {
  const { effect } = explain.classification;
  const { transaction } = explain;
  if (effect.kind !== 'spend' || transaction.eur === null) return `Цей рядок окремо: ${describeEffect({ explain })}`;
  const eur = formatEurApprox(Math.abs(transaction.eur));
  return effect.sign === 1
    ? `Цей рядок окремо додає ${eur} до «${effect.category}»; решта ланцюжка віднімає своє.`
    : `Цей рядок окремо віднімає ${eur} від «${effect.category}»: повертає частину холду.`;
};

type ChainMember = TransactionExplain['related'][number];

/** The chain id is its first leg's id: the sale before the onward transfer, the hold before its release. */
const orderMembers = (explain: TransactionExplain): ChainMember[] => {
  const { chainId } = explain.transaction;
  return [explain.transaction, ...explain.related].toSorted(
    (left, right) =>
      Number(right.id === chainId) - Number(left.id === chainId) ||
      left.date.localeCompare(right.date) ||
      left.createdAt.localeCompare(right.createdAt),
  );
};

const formatPlain = (value: number, currency: string) => formatMoney(Math.abs(value), currency);

const ORDINALS = ['', 'друге', 'третє', 'четверте', 'п’яте'] as const;

/** «скасування», «друге скасування»…: a repeated term is told apart by its place in the chain. */
const nameRepeat = ({ word, index }: { word: string; index: number }) => {
  const ordinal = ORDINALS[index];
  return index === 0 ? word : ordinal === undefined ? `${word} №${String(index + 1)}` : `${ordinal} ${word}`;
};

/**
 * «Холд 52 141,76 − скасування 51 361,07 (10 лист.) − друге скасування 780,69 (11 лист.) = 0,00 грн»:
 * the chain's arithmetic in the card's own currency, where it nets out exactly, before any rate gets
 * involved. Every term is named; terms that share a name also carry their day.
 */
const describeChainSum = (explain: TransactionExplain): string | null => {
  const members = orderMembers(explain);
  const currency = members[0]?.currency;
  if (currency === undefined || members.some((member) => member.currency !== currency)) return null;
  const instalment = explain.chain?.kind === 'instalment';
  const credit = instalment ? 'розстрочка' : 'скасування';
  const charge = instalment ? 'платіж' : 'списання';
  const counts = { credit: 0, charge: 0 };
  const repeated = {
    credit: members.filter((member) => member.type === 'income').length > 1,
    charge: members.slice(1).filter((member) => member.type !== 'income').length > 1,
  };
  const terms = members.map((member, index) => {
    const figure = formatNumber(Math.abs(member.amount), { digits: 2 });
    if (index === 0) return `${instalment ? 'Покупка' : 'Холд'} ${figure}`;
    const kind = member.type === 'income' ? 'credit' : 'charge';
    const name = nameRepeat({ word: kind === 'credit' ? credit : charge, index: counts[kind] });
    counts[kind] += 1;
    const day = repeated[kind] ? ` (${formatDayNoYear(member.date)})` : '';
    return `${kind === 'credit' ? '−' : '+'} ${name} ${figure}${day}`;
  });
  const net = Math.round(members.reduce((sum, member) => sum + (member.type === 'income' ? -1 : 1) * member.amount, 0) * 100) / 100;
  return keepTogether(`${terms.join(' ')} = ${net < 0 ? '−' : ''}${formatPlain(net, currency)}`);
};

const describeChainNet = (explain: TransactionExplain): string => {
  const months = new Set(orderMembers(explain).map((member) => member.date.slice(0, 7)));
  // Float noise around zero must not print as «−0 €».
  const net = Math.round((explain.chain?.netEur ?? 0) * 100) / 100 || 0;
  return `${months.size === 1 ? 'у витратах місяця' : 'разом у витратах'}: ${formatEurApprox(net)}`;
};

const lowerFirst = (text: string) => `${text.charAt(0).toLocaleLowerCase('uk')}${text.slice(1)}`;

/** «Як рахується»: the money move as a whole first, then what this one row does on its own. */
const HowItCounts = ({ explain }: { explain: TransactionExplain }) => {
  const { chain, split, transaction } = explain;
  if (split !== null) {
    const parts = split.parts.map((part) => `${part.category ?? 'Інше'} ${formatPlain(part.amount, part.currency)}`).join(' + ');
    return (
      <div className="verdict">
        <b>
          Розділено на {pluralize(split.parts.length, ['частину', 'частини', 'частин'])}: {parts} ={' '}
          {formatPlain(split.parent.amount, split.parent.currency)}
        </b>
        <span>
          {transaction.splitOfId === null
            ? 'Сам рядок банку не рахується ні в балансі, ні у витратах: замість нього рахуються частини.'
            : `Ця частина: ${lowerFirst(describeEffect({ explain }))}`}
        </span>
      </div>
    );
  }
  if (chain === null) {
    return (
      <div className="verdict">
        <span>{describeEffect({ explain })}</span>
      </div>
    );
  }
  if (chain.kind === 'sale') {
    const members = orderMembers(explain);
    const first = members[0];
    const last = members.at(-1);
    return (
      <div className="verdict">
        {first !== undefined && last !== undefined && (
          <b className="num">
            {formatMoney(first.amount, first.currency)} → {formatMoney(last.amount, last.currency)} · курс{' '}
            {formatExchangeRate({ amount: last.amount, currency: last.currency, toAmount: first.amount, toCurrency: first.currency })}
          </b>
        )}
        <span>Продаж валюти ФОП через гривневий рахунок на картку: обидва кроки — перекази, не витрата.</span>
      </div>
    );
  }
  const sum = describeChainSum(explain);
  return (
    <div className="verdict">
      <b>
        {sum === null ? 'Разом' : sum}; {describeChainNet(explain)}
      </b>
      {chain.kind === 'instalment' && (
        <span>Покупку перетворено на розстрочку: у витратах рахуються щомісячні платежі, а не сама покупка.</span>
      )}
      <span>{describeOwnShare({ explain })}</span>
    </div>
  );
};

const describeRule = (rule: NonNullable<Classification['rule']>, names: ReadonlyMap<string, string>) => {
  const condition = [rule.pattern === null ? null : `«${rule.pattern}»`, rule.mcc === null ? null : `MCC ${rule.mcc}`]
    .filter(Boolean)
    .join(' + ');
  const action =
    rule.category ?? `переказ → ${names.get(rule.transferToAccountId ?? '') ?? rule.transferToAccountId ?? ''}`;
  return `${condition} → ${action} (пріоритет ${rule.priority})`;
};

const VERDICTS: Readonly<Record<Classification['verdict'], string>> = {
  rule: 'Спрацювало правило',
  'own-transfer': 'Банк показав, що гроші пішли на твій інший рахунок (IBAN або власна картка), тому це переказ.',
  p2p: 'Купівля USDT через Binance P2P: гривні пішли продавцю, USDT прийшли на Binance.',
  atm: 'Зняття готівки (MCC 6011): переказ на готівковий рахунок, комісія банкомата окремо.',
  cancellation: 'Скасування холду або повернення: категорія взята з початкової покупки.',
  valuation: 'Переоцінка: різниця між звітом провайдера і порахованим балансом.',
  manual: 'Категорію вибрано вручну.',
  imported: 'Імпорт з ZenMoney: категорія звідти.',
  fallback: 'Жодне правило не підійшло, тому «Інше» і позначка «уточнити».',
};

const describeRate = (rate: RateUsage) => {
  if (rate.kind === 'base') return 'Сума вже в євро, перерахунок не потрібен.';
  const base = formatRatePerEur({ perEur: rate.perEur, currency: rate.currency });
  switch (rate.kind) {
    case 'daily':
      return `${base} · ${rate.source === 'nbu' ? 'курс НБУ' : 'денний курс'} на ${formatDay(rate.date ?? '')}`;
    case 'yearly':
      return `${base} · середній курс ${rate.year ?? ''} року (денного курсу ближче ніж за 7 днів немає)`;
    case 'latest':
      return `${base} · останній відомий курс (${formatDay(rate.date ?? '')}); ні денного, ні річного немає`;
  }
};

const BankLineFacts = ({ line, currency }: { line: BankLine; currency: string }) => (
  <dl className="facts">
    {line.description !== null && (
      <>
        <dt>Опис</dt>
        <dd>{keepTogether(line.description)}</dd>
      </>
    )}
    {line.counterparty !== null && (
      <>
        <dt>Контрагент</dt>
        <dd>{keepTogether(line.counterparty)}</dd>
      </>
    )}
    {line.counterIban !== null && (
      <>
        <dt>IBAN</dt>
        <dd className="num">{line.counterIban}</dd>
      </>
    )}
    {line.mcc !== null && (
      <>
        <dt>MCC</dt>
        <dd>
          <span className="num">{line.mcc}</span>
          {line.mccName !== null && ` · ${line.mccName}`}
        </dd>
      </>
    )}
    {line.amount !== null && (
      <>
        <dt>Сума в банку</dt>
        <dd className="num">{formatMoney(line.amount, currency)}</dd>
      </>
    )}
    {line.operationAmount !== null && line.operationCurrency !== null && line.operationCurrency !== currency && (
      <>
        <dt>Сума операції</dt>
        <dd className="num">{formatMoney(line.operationAmount, line.operationCurrency)}</dd>
      </>
    )}
    {line.balanceAfter !== null && (
      <>
        <dt>Баланс після</dt>
        <dd className="num">{formatMoney(line.balanceAfter, currency)}</dd>
      </>
    )}
    {line.bookedAt !== null && (
      <>
        <dt>Час</dt>
        <dd>{line.bookedAt.length > 10 ? formatDateTime(line.bookedAt) : formatDay(line.bookedAt)}</dd>
      </>
    )}
    {line.hold === true && (
      <>
        <dt>Холд</dt>
        <dd>так, банк ще може змінити суму</dd>
      </>
    )}
    {line.comment !== null && (
      <>
        <dt>Коментар</dt>
        <dd>{keepTogether(line.comment)}</dd>
      </>
    )}
  </dl>
);

const sumDeltas = (values: readonly number[]) => Math.round(values.reduce((sum, value) => sum + value, 0) * 100) / 100;

/** What a companion row did to the statement account, signed like the bank's line. */
const findCompanionDelta = (row: BankCheck['companions'][number], accountId: string) =>
  row.type === 'transfer'
    ? row.accountId === accountId
      ? -row.amount
      : (row.toAmount ?? row.amount)
    : row.type === 'expense'
      ? -row.amount
      : row.amount;

/**
 * The record against the bank's line: both amounts and the difference, and the row that makes it
 * up. Without the stored line the bank's amount is unknown, so it lists the day's hand rows instead.
 */
const BankCheckBlock = ({ check, names }: { check: BankCheck; names: ReadonlyMap<string, string> }) => {
  const { bankAmount, recordAmount, currency, companions, compensatedById, accountId } = check;
  const compensating = companions.find((row) => row.id === compensatedById);
  const difference = bankAmount === null ? null : Math.round((bankAmount - recordAmount) * 100) / 100;
  const together = sumDeltas([recordAmount, ...companions.map((row) => findCompanionDelta(row, accountId))]);
  return (
    <div className={bankAmount !== null && compensating !== undefined ? 'bank-check explained' : 'bank-check'}>
      <dl className="facts">
        <dt>Сума в банку</dt>
        <dd className="num">{bankAmount === null ? <span className="muted">невідома</span> : formatSignedMoney(bankAmount, currency)}</dd>
        <dt>У записі</dt>
        <dd className="num">{formatSignedMoney(recordAmount, currency)}</dd>
        {difference !== null && (
          <>
            <dt>Різниця</dt>
            <dd className={compensating === undefined ? 'num check-bad' : 'num'}>{formatSignedMoney(difference, currency)}</dd>
          </>
        )}
        {bankAmount === null && companions.length > 0 && (
          <>
            <dt>{companions.length === 1 ? 'Разом з ним' : 'Разом з ними'}</dt>
            <dd className="num">{formatSignedMoney(together, currency)}</dd>
          </>
        )}
      </dl>
      {difference !== null &&
        (compensating === undefined ? (
          <p className="note warn-text">Жоден запис не пояснює різницю: суму змінено проти банку.</p>
        ) : (
          <p className="note">Різницю покриває запис нижче, тож разом вони дають суму банку.</p>
        ))}
      {bankAmount === null && (
        <p className="note">
          {companions.length === 0
            ? 'Рядок банку пов’язано, але його вміст не збережено, тож суму банку тут не звірити.'
            : compensating === undefined
              ? 'Рядок банку пов’язано, але його вміст не збережено. Того ж дня на цьому рахунку є записи без рядка банку:'
              : 'Рядок банку пов’язано, але його вміст не збережено. Різницю між банком і записом, схоже, покриває запис того ж дня без рядка банку:'}
        </p>
      )}
      {companions.map((row) => (
        <TransactionLine key={row.id} transaction={row} accountNames={names} />
      ))}
    </div>
  );
};

/**
 * A long note reads as a heading and a remark: «Андрій Маркович, подарунок на ДН» over
 * «переказ 4 454,80 ₴ = …». The first line, or the text before a bracketed aside, is the heading.
 */
const splitNote = (note: string): { heading: string; rest: string | null } => {
  const [first = note, ...lines] = note.split('\n');
  const aside = /^(.{8,}?)\s+\((.+)\)\s*$/u.exec(first);
  if (aside !== null && first.length > 48) {
    const [, heading = first, remark = ''] = aside;
    return { heading, rest: [remark, ...lines].join(' ').trim() || null };
  }
  return { heading: first, rest: lines.join(' ').trim() || null };
};

const ESTIMATE_SUFFIX = ' (орієнтовно)';

/** Amount, date, note, tags and the «орієнтовно» mark, as the owner would fix a typo. */
/** Amount and date belong to the split once a row has parts; note and tags stay the owner's. */
const DetailsForm = ({ transaction, locked }: { transaction: TransactionExplain['transaction']; locked: boolean }) => {
  const update = useUpdateTransaction();
  const estimated = transaction.note?.includes(ESTIMATE_MARKER) === true;
  const [amount, setAmount] = useState(toInputAmount(transaction.amount));
  const [date, setDate] = useState(transaction.date);
  const [note, setNote] = useState((transaction.note ?? '').replace(ESTIMATE_SUFFIX, ''));
  const [tags, setTags] = useState(transaction.tags.join(', '));
  const [rough, setRough] = useState(estimated);
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const cleanNote = note.trim().replaceAll(ESTIMATE_MARKER, '').trim();
    update.mutate(
      {
        id: transaction.id,
        patch: {
          ...(parseAmount(amount) === transaction.amount ? {} : { amount: parseAmount(amount) }),
          ...(date === transaction.date ? {} : { date }),
          note: rough ? `${cleanNote}${ESTIMATE_SUFFIX}`.trim() : cleanNote,
          tags: tags
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <details className="fold">
      <summary>{locked ? 'Коментар, мітки' : 'Сума, дата, коментар, мітки'}</summary>
      <form className="form" onSubmit={submit}>
        {!locked && (
          <>
            <label>
              Сума, {transaction.currency}
              <input inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            </label>
            <label>
              Дата
              <DateInput label="Дата" value={date} onChange={setDate} />
            </label>
          </>
        )}
        <label className="full">
          Коментар
          <input value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        <label className="full">
          Мітки через кому (trip:lisbon-2026-11, shared)
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        <label className="full" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={rough} onChange={(event) => setRough(event.target.checked)} style={{ width: 18 }} />
          Сума орієнтовна (ще чекаю точну з банку)
        </label>
        <div className="actions">
          <button type="submit" className="btn small primary" disabled={update.isPending}>
            Зберегти зміни
          </button>
          {saved && <span className="note">Збережено</span>}
          {update.isError && <span className="note err">{describeError(update.error)}</span>}
        </div>
      </form>
    </details>
  );
};

type PartDraft = { key: number; category: string; amount: string; note: string };

const toCents = (value: string) => {
  const amount = parseAmount(value);
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0;
};

const draftParts = (explain: TransactionExplain): PartDraft[] => {
  if (explain.split !== null) {
    return explain.split.parts.map((part, index) => ({
      key: index,
      category: part.category ?? '',
      amount: toInputAmount(part.amount),
      note: part.note === explain.split?.parent.note ? '' : (part.note ?? ''),
    }));
  }
  const { transaction } = explain;
  return [
    { key: 0, category: transaction.category ?? '', amount: toInputAmount(transaction.amount), note: '' },
    { key: 1, category: '', amount: '', note: '' },
  ];
};

/**
 * One bank line, several categories: a supermarket run that was half household goods, a dinner
 * partly for a friend. The parts must add up to the line before they can be saved.
 */
const SplitEditor = ({ explain, categories }: { explain: TransactionExplain; categories: readonly Category[] }) => {
  const parent = explain.split?.parent ?? explain.transaction;
  const split = useSplitTransaction();
  const unsplit = useUnsplitTransaction();
  const { openTransaction } = useDrawer();
  const [parts, setParts] = useState(() => draftParts(explain));
  const [nextKey, setNextKey] = useState(parts.length);
  const usable = categories.filter((category) => !category.archived && (parent.type === 'income' || category.forExpense));
  const leftCents = Math.round(parent.amount * 100) - parts.reduce((sum, part) => sum + toCents(part.amount), 0);
  const valid = parts.length >= 2 && leftCents === 0 && parts.every((part) => part.category !== '' && toCents(part.amount) > 0);
  const busy = split.isPending || unsplit.isPending;
  const change = (key: number, patch: Partial<PartDraft>) =>
    setParts(parts.map((part) => (part.key === key ? { ...part, ...patch } : part)));
  const fillRemainder = () => {
    const last = parts.at(-1);
    if (last !== undefined) change(last.key, { amount: toInputAmount((toCents(last.amount) + leftCents) / 100) });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    split.mutate(
      {
        id: parent.id,
        input: {
          parts: parts.map((part) => ({
            category: part.category,
            amount: parseAmount(part.amount),
            ...(part.note.trim() === '' ? {} : { note: part.note.trim() }),
          })),
        },
      },
      { onSuccess: (result) => openTransaction(result.parent.id) },
    );
  };

  return (
    <details className="fold" open={explain.split !== null}>
      <summary>{explain.split === null ? 'Розділити на частини' : 'Змінити розподіл'}</summary>
      <form className="split-editor" onSubmit={submit}>
        <p className="note">
          Кожна частина — окрема {parent.type === 'income' ? 'сума доходу' : 'витрата'} зі своєю категорією. Рядок банку лишається
          одним, тож синхронізація його не продублює.
        </p>
        {parts.map((part, index) => (
          <div key={part.key} className="split-row">
            <select
              aria-label={`Категорія частини ${index + 1}`}
              value={part.category}
              onChange={(event) => change(part.key, { category: event.target.value })}
            >
              <option value="" disabled>
                Категорія
              </option>
              {usable.map((entry) => (
                <option key={entry.name}>{entry.name}</option>
              ))}
            </select>
            <input
              inputMode="decimal"
              aria-label={`Сума частини ${index + 1}, ${parent.currency}`}
              placeholder={parent.currency}
              value={part.amount}
              onChange={(event) => change(part.key, { amount: event.target.value })}
            />
            <input
              aria-label={`Коментар частини ${index + 1}`}
              placeholder="коментар"
              value={part.note}
              onChange={(event) => change(part.key, { note: event.target.value })}
            />
            <button
              type="button"
              className="btn small"
              aria-label={`Прибрати частину ${index + 1}`}
              disabled={parts.length <= 2}
              onClick={() => setParts(parts.filter((other) => other.key !== part.key))}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="inline-form">
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setParts([...parts, { key: nextKey, category: '', amount: leftCents > 0 ? toInputAmount(leftCents / 100) : '', note: '' }]);
              setNextKey(nextKey + 1);
            }}
          >
            + Частина
          </button>
          {leftCents !== 0 && (
            <button type="button" className="btn small" onClick={fillRemainder}>
              Залишок в останню
            </button>
          )}
          <span className={leftCents === 0 ? 'note' : 'note warn-text'} aria-live="polite">
            {leftCents === 0
              ? `Разом ${formatMoney(parent.amount, parent.currency)}`
              : `${leftCents > 0 ? 'Не розподілено' : 'Забагато на'} ${formatMoney(Math.abs(leftCents) / 100, parent.currency)}`}
          </span>
        </div>
        <div className="actions">
          <button type="submit" className="btn small primary" disabled={busy || !valid}>
            Зберегти розподіл
          </button>
          {explain.split !== null && (
            <button
              type="button"
              className="btn small"
              disabled={busy}
              onClick={() => unsplit.mutate(parent.id, { onSuccess: (row) => openTransaction(row.id) })}
            >
              Скасувати розподіл
            </button>
          )}
        </div>
        {[split, unsplit].map((mutation, index) =>
          mutation.isError ? (
            <p key={index} className="note err">
              {describeError(mutation.error)}
            </p>
          ) : null,
        )}
      </form>
    </details>
  );
};

const EditActions = ({
  explain,
  accounts,
  categories,
}: {
  explain: TransactionExplain;
  accounts: readonly AccountBalance[];
  categories: readonly Category[];
}) => {
  const { transaction } = explain;
  const update = useUpdateTransaction();
  const remove = useDeleteTransaction();
  const saveRule = useSaveRule();
  const { close } = useDrawer();
  const usable = categories.filter((category) => !category.archived);
  const [category, setCategory] = useState(transaction.category ?? '');
  const [toAccountId, setToAccountId] = useState('');
  const [toAmount, setToAmount] = useState('');
  const [pattern, setPattern] = useState(explain.payee.pattern);
  const [ruleCategory, setRuleCategory] = useState(transaction.category ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const active = accounts.filter((account) => !account.archived && account.id !== transaction.accountId);
  const target = accounts.find((account) => account.id === toAccountId);
  const crossCurrency = target !== undefined && target.currency !== transaction.currency;
  const busy = update.isPending || remove.isPending || saveRule.isPending;
  const isPart = transaction.splitOfId !== null;
  const isSplit = explain.split !== null && !isPart;
  const spends = transaction.type === 'expense' || transaction.type === 'income';
  const save = (patch: UpdateTransaction) =>
    update.mutate({ id: transaction.id, patch }, { onSuccess: () => setMessage('Збережено') });

  const createRule = (event: FormEvent) => {
    event.preventDefault();
    saveRule.mutate(
      {
        id: null,
        input: {
          pattern: pattern.trim(),
          mcc: null,
          accountId: null,
          category: ruleCategory,
          transferToAccountId: null,
          priority: 100,
          note: `Створено з запису ${formatDay(transaction.date)}`,
        },
      },
      { onSuccess: () => setMessage(`Правило «${pattern.trim()}» → ${ruleCategory} збережено`) },
    );
  };

  return (
    <section>
      <h2>Змінити</h2>
      <div className="card">
        <DetailsForm key={transaction.id} transaction={transaction} locked={explain.split !== null} />
        {!isSplit && (spends || transaction.type === 'transfer') && (
          <div className="inline-form">
            <select aria-label="Категорія" value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="" disabled>
                Вибери категорію
              </option>
              {usable.map((entry) => (
                <option key={entry.name}>{entry.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn small"
              disabled={busy || category === ''}
              onClick={() => {
                const type = transaction.type === 'income' ? 'income' : 'expense';
                save({ ...(type === transaction.type ? {} : { type }), category });
              }}
            >
              {transaction.type === 'income' ? 'Записати як дохід' : 'Записати як витрату'}
            </button>
          </div>
        )}
        {transaction.type !== 'valuation' && explain.split === null && (
          <div className="inline-form">
            <select aria-label="Переказ на рахунок" value={toAccountId} onChange={(event) => setToAccountId(event.target.value)}>
              <option value="" disabled>
                Переказ на рахунок…
              </option>
              {active.map((account) => (
                <option key={account.id} value={account.id}>
                  {formatAccountName(account.name)} ({account.currency})
                </option>
              ))}
            </select>
            {crossCurrency && (
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Зараховано в ${target.currency}`}
                placeholder={`${target.currency}, 0 якщо невідомо`}
                value={toAmount}
                onChange={(event) => setToAmount(event.target.value)}
              />
            )}
            <button
              type="button"
              className="btn small"
              disabled={busy || toAccountId === ''}
              onClick={() =>
                save({
                  type: 'transfer',
                  toAccountId,
                  toAmount: crossCurrency && toAmount.trim() !== '' ? parseAmount(toAmount) : null,
                })
              }
            >
              Це переказ
            </button>
          </div>
        )}
        {spends && <SplitEditor key={`split-${explain.split?.parts.map((part) => part.id).join() ?? transaction.id}`} explain={explain} categories={categories} />}
        {spends && explain.split === null && (
          <form className="inline-form" onSubmit={createRule}>
            <input aria-label="Текст правила" value={pattern} onChange={(event) => setPattern(event.target.value)} />
            <select aria-label="Категорія правила" value={ruleCategory} onChange={(event) => setRuleCategory(event.target.value)}>
              <option value="" disabled>
                Категорія
              </option>
              {usable.map((entry) => (
                <option key={entry.name}>{entry.name}</option>
              ))}
            </select>
            <button type="submit" className="btn small" disabled={busy || pattern.trim().length < 2 || ruleCategory === ''}>
              Створити правило з цього
            </button>
          </form>
        )}
        <div className="inline-form">
          {transaction.needsReview && (
            <button type="button" className="btn small primary" disabled={busy} onClick={() => save({ needsReview: false })}>
              Залишити як є
            </button>
          )}
          {!isPart && (
            <DeleteButton
              label={isSplit ? 'Видалити запис і частини' : 'Видалити запис'}
              disabled={busy}
              onConfirm={() => remove.mutate(transaction.id, { onSuccess: close })}
            />
          )}
        </div>
        {message !== null && <p className="note">{message}</p>}
        {[update, remove, saveRule].map((mutation, index) =>
          mutation.isError ? (
            <p key={index} className="note err">
              {describeError(mutation.error)}
            </p>
          ) : null,
        )}
      </div>
    </section>
  );
};

const DrawerBody = ({ explain }: { explain: TransactionExplain }) => {
  const accounts = useAccounts();
  const categories = useCategories();
  const merge = useMergeTransaction();
  const { openTransaction } = useDrawer();
  const names = new Map((accounts.data ?? []).map((account) => [account.id, formatAccountName(account.name)]));
  const { transaction, origin, classification, fx, twin } = explain;
  const { title, amount, tone } = describeLine({ transaction, accountNames: names });
  const line = origin.bankLine;
  const remark = transaction.note === null ? null : splitNote(transaction.note).rest;

  return (
    <>
      <div>
        <div className="amount num">
          <span className={tone}>{amount}</span>
        </div>
        {remark !== null && <p className="drawer-remark">{keepTogether(remark)}</p>}
        <p className="note">
          {formatDay(transaction.date)} · {formatAccountName(explain.account.name)}
          {explain.target !== null && ` → ${formatAccountName(explain.target.name)}`}
          {transaction.eur !== null && transaction.currency !== 'EUR' && ` · ≈\u00a0${formatEurApprox(Math.abs(transaction.eur))}`}
        </p>
        {title !== '' && (transaction.type === 'expense' || transaction.type === 'income') && (
          <p className="note">
            <a className="link" href={buildTableHref({ payee: explain.payee.key })}>
              Усі записи «{keepTogether(explain.payee.name)}»
            </a>
          </p>
        )}
      </div>

      <section>
        <h2>Як рахується</h2>
        <HowItCounts explain={explain} />
      </section>

      {explain.split === null && explain.related.length > 0 && (
        <section>
          <h2>Пов’язані записи · {pluralize(explain.related.length + 1, ['запис', 'записи', 'записів'])}</h2>
          {orderMembers(explain).map((row) =>
            row.id === transaction.id ? (
              <div key={row.id} className="chain-self" aria-current="true">
                <TransactionLine transaction={row} accountNames={names} />
                <span className="chip muted chain-self-mark">цей запис</span>
              </div>
            ) : (
              <TransactionLine key={row.id} transaction={row} accountNames={names} />
            ),
          )}
        </section>
      )}

      <section>
        <h2>Чому так</h2>
        <div className="verdict">
          <span>{VERDICTS[classification.verdict]}</span>
          {classification.rule !== null && (
            <span>
              <a className="link" href={buildHref({ view: 'rules', query: { rule: classification.rule.id } })}>
                {describeRule(classification.rule, names)}
              </a>
            </span>
          )}
          {classification.overridden && classification.rule !== null && (
            <span className="chip warn">правило каже інакше: запис змінено вручну</span>
          )}
          {transaction.reviewReason !== null && <span className="note">{keepTogether(transaction.reviewReason)}</span>}
        </div>
      </section>

      <section>
        <h2>Звідки запис</h2>
        <p className="note" style={{ marginBottom: 8 }}>
          <SourceMark source={origin.source} size="sm" /> {SOURCE_LABELS[origin.source]}
          {origin.linked ? ' · пов’язаний з рядком банку' : ' · без рядка банку'}
          {origin.source !== 'zenmoney' && ` · створено ${formatDateTime(origin.createdAt)}`}{' '}
          {isEstimated(transaction) && <span className="chip warn">сума орієнтовна</span>}
        </p>
        {line !== null && (
          <BankLineFacts
            line={line}
            currency={line.accountId === transaction.toAccountId ? (transaction.toCurrency ?? transaction.currency) : transaction.currency}
          />
        )}
        {explain.bankCheck !== null && <BankCheckBlock check={explain.bankCheck} names={names} />}
        {origin.linked && line === null && explain.bankCheck === null && (
          <p className="note">Рядок банку пов’язано, але його вміст не збережено.</p>
        )}
      </section>

      <section>
        <h2>Курс</h2>
        <dl className="facts">
          <dt>У євро</dt>
          <dd className="num">{transaction.eur === null ? 'курсу немає' : formatEurApprox(transaction.eur)}</dd>
          {transaction.operationEur !== null ? (
            <>
              <dt>Звідки</dt>
              <dd>Картку списали в євро: береться сума операції {formatMoney(transaction.operationEur, 'EUR')}, а не перерахунок гривні за курсом.</dd>
              <dt>Курс банку</dt>
              <dd>
                {formatExchangeRate({
                  amount: transaction.amount,
                  currency: transaction.currency,
                  toAmount: transaction.operationEur,
                  toCurrency: 'EUR',
                })}
                {fx !== null && fx.kind !== 'base' && ` (НБУ: ${formatRatePerEur({ perEur: fx.perEur, currency: fx.currency })})`}
              </dd>
            </>
          ) : (
            <>
              <dt>Курс</dt>
              <dd>{fx === null ? `Для ${transaction.currency} курсу немає` : describeRate(fx)}</dd>
            </>
          )}
          {explain.transferRate !== null && transaction.toCurrency !== null && transaction.toAmount !== null && (
            <>
              <dt>Обмін</dt>
              <dd className="num">
                {formatMoney(transaction.amount, transaction.currency)} → {formatMoney(transaction.toAmount, transaction.toCurrency)} · курс{' '}
                {formatExchangeRate({
                  amount: transaction.amount,
                  currency: transaction.currency,
                  toAmount: transaction.toAmount,
                  toCurrency: transaction.toCurrency,
                })}
              </dd>
            </>
          )}
        </dl>
      </section>

      {explain.split !== null && (
        <section>
          <h2>Частини</h2>
          {explain.split.parts.map((row) =>
            row.id === transaction.id ? null : <TransactionLine key={row.id} transaction={row} accountNames={names} />,
          )}
          {transaction.splitOfId !== null && (
            <>
              <p className="note" style={{ marginTop: 8 }}>
                Рядок банку, з якого вони розділені:
              </p>
              <TransactionLine transaction={explain.split.parent} accountNames={names} />
            </>
          )}
        </section>
      )}

      {twin !== null && (
        <section>
          <h2>Можливий дубль</h2>
          <div className="card" style={{ marginTop: 8 }}>
            <span className="note">
              {twin.relation === 'duplicates' ? 'Схоже, це дубль цього запису:' : 'Цей запис, схоже, дублює рядок банку:'}
            </span>
            <TransactionLine transaction={twin.transaction} accountNames={names} />
            <div className="inline-form">
              <button
                type="button"
                className="btn small primary"
                disabled={merge.isPending}
                onClick={() =>
                  merge.mutate(
                    twin.relation === 'duplicates'
                      ? { id: transaction.id, intoId: twin.transaction.id }
                      : { id: twin.transaction.id, intoId: transaction.id },
                    { onSuccess: (kept) => openTransaction(kept.id) },
                  )
                }
              >
                Об’єднати
              </button>
            </div>
            {merge.isError && <p className="note err">{describeError(merge.error)}</p>}
          </div>
        </section>
      )}

      {accounts.data !== undefined && categories.data !== undefined && (
        <EditActions key={transaction.id} explain={explain} accounts={accounts.data} categories={categories.data} />
      )}
    </>
  );
};

/** «Чому так?»: everything behind one row, from any list. */
export const TransactionDrawer = () => {
  const { openId, close } = useDrawer();
  const explain = useExplanation(openId);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (openId === null) return undefined;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, close]);

  if (openId === null) return null;
  const note = explain.data?.transaction.note;
  const heading = note
    ? splitNote(note).heading
    : explain.data?.transaction.type === 'transfer'
      ? UNNAMED_TRANSFER
      : (explain.data?.transaction.category ?? 'Запис');

  return (
    <>
      <div className="scrim" onClick={close} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="drawer-head">
          <h3 id="drawer-title">{keepTogether(heading)}</h3>
          <button type="button" className="close" ref={closeRef} aria-label="Закрити" onClick={close}>
            ✕
          </button>
        </div>
        {explain.isPending && <p className="note loading">Завантажую…</p>}
        {explain.isError && <p className="note err">{describeError(explain.error)}</p>}
        {explain.data !== undefined && <DrawerBody explain={explain.data} />}
      </aside>
    </>
  );
};
