import { type FileImportKind, FileImportKindSchema, type FileImportRequest, type FileImportResult } from '@hroshi/schema';
import { useEffect, useId, useState } from 'react';

import { describeError } from '../api.ts';
import { InfoTip } from '../components/InfoTip.tsx';
import { formatAccountName, formatDay, formatMoney, formatWarning, pluralize } from '../format.ts';
import { useImportFiles } from '../queries.ts';

const KINDS: Readonly<Record<FileImportKind, { title: string; files: string; multiple: boolean }>> = {
  mono: { title: 'Monobank', files: 'mono_export.json — файл скрипта mono_export.py', multiple: false },
  binance: { title: 'Binance', files: 'обидва файли з папки експорту: p2p_completed.json і balances.json', multiple: true },
  freedom24: { title: 'Freedom24', files: 'звіт брокера *_all.json', multiple: false },
};

/** How long «Точно імпортувати?» stays armed. */
const CONFIRM_MS = 4000;

type Picked = FileImportRequest['files'];

/** Every import format is JSON; reading it here keeps the request a plain JSON body. */
const readFiles = async (list: FileList): Promise<Picked> =>
  Promise.all(
    [...list].map(async (file) => {
      try {
        return { name: file.name, lastModified: new Date(file.lastModified).toISOString(), content: JSON.parse(await file.text()) };
      } catch {
        throw new Error(`«${file.name}» — не JSON`);
      }
    }),
  );

const describePeriod = ({ from, to }: { from: string | null; to: string | null }) =>
  from === null || to === null ? null : from === to ? formatDay(from) : `${formatDay(from)} — ${formatDay(to)}`;

const Preview = ({ result }: { result: FileImportResult }) => {
  const period = describePeriod(result);
  return (
    <div className="import-preview">
      <p>
        <b>{result.dryRun ? 'Перевірка, нічого не записано:' : 'Імпортовано за цим планом:'}</b>{' '}
        {result.kind === 'freedom24'
          ? `звіт прочитано${period === null ? '' : `, грошові рухи ${period}`}`
          : `${pluralize(result.lines, ['рядок', 'рядки', 'рядків'])} у файлі${period === null ? '' : `, ${period}`}`}
        .
      </p>
      {result.kind !== 'freedom24' && (
        <div className="import-counts">
          <span>
            нових: <b className="num">{result.added}</b>
          </span>
          <span>
            уже є: <b className="num">{result.known}</b>
          </span>
          {result.dismissed > 0 && (
            <span>
              видалені раніше: <b className="num">{result.dismissed}</b>
            </span>
          )}
          <span>
            пропущено: <b className="num">{result.skipped}</b>
          </span>
        </div>
      )}
      {result.accounts.length > 0 && (
        <div className="list">
          {result.accounts.map((account) => {
            const accountPeriod = describePeriod(account);
            const currency = account.currency;
            return (
              <div key={account.accountId ?? account.name} className="row">
                <span>{formatAccountName(account.name)}</span>
                <span className="r num">+{account.added}</span>
                <span className="s">
                  {account.added === 0
                    ? `нового немає · уже є: ${account.known}`
                    : [
                        `уже є: ${account.known}`,
                        accountPeriod,
                        currency !== null && account.outflow > 0 ? `витрати ${formatMoney(account.outflow, currency)}` : null,
                        currency !== null && account.inflow > 0 ? `надходження ${formatMoney(account.inflow, currency)}` : null,
                        account.likelyHand > 0
                          ? `${pluralize(account.likelyHand, ['рядок', 'рядки', 'рядків'])}, ймовірно, зв’яжуться з наявними записами`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                  {account.dismissed > 0 && ` · видалені раніше: ${account.dismissed}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {result.notes.length > 0 && (
        <ul className="import-notes">
          {result.notes.map((note) => (
            <li key={note}>{formatWarning(note)}</li>
          ))}
        </ul>
      )}
      {result.outcome !== null && (
        <p className="note">
          Готово: нових записів {result.outcome.created}, оновлено {result.outcome.updated}.
          {result.outcome.warnings.length > 0 && ` ${result.outcome.warnings.map(formatWarning).join(' · ')}`}
        </p>
      )}
    </div>
  );
};

/** Back-fills from files: a dry run says what would change, the import itself only after that. */
export const FileImport = () => {
  const [kind, setKind] = useState<FileImportKind>('mono');
  const [files, setFiles] = useState<Picked>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);
  const run = useImportFiles();
  const inputId = useId();
  const { files: hint, multiple } = KINDS[kind];
  const checked = run.data?.dryRun === true && run.data.kind === kind;
  // A Mono file with nothing new has nothing to write; Binance still books today's valuation.
  const nothingToDo = checked && kind === 'mono' && run.data?.added === 0;

  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const reset = () => {
    setFiles([]);
    setReadError(null);
    setArmed(false);
    run.reset();
  };

  return (
    <div className="card file-import">
      <div className="seg" role="group" aria-label="Що імпортувати">
        {FileImportKindSchema.options.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === kind}
            onClick={() => {
              setKind(option);
              reset();
            }}
          >
            {KINDS[option].title}
          </button>
        ))}
      </div>
      <div className="file-pick">
        <span className="small muted">
          {multiple ? 'Файли' : 'Файл'}: {hint}
        </span>
        <div className="inline-form">
          <input
            id={inputId}
            key={kind}
            className="sr-only"
            type="file"
            accept="application/json,.json"
            multiple={multiple}
            onChange={(event) => {
              const list = event.target.files;
              reset();
              if (list === null || list.length === 0) return;
              readFiles(list).then(setFiles, (error: unknown) => setReadError(describeError(error)));
            }}
          />
          <label className="btn small" htmlFor={inputId}>
            {multiple ? 'Обрати файли' : 'Обрати файл'}
          </label>
          <span className="small">{files.length === 0 ? 'нічого не обрано' : files.map((file) => file.name).join(', ')}</span>
        </div>
      </div>
      <div className="inline-form">
        <button
          type="button"
          className="btn small"
          disabled={files.length === 0 || run.isPending}
          onClick={() => run.mutate({ kind, dryRun: true, files })}
        >
          {run.isPending && run.variables.dryRun ? 'Перевіряю…' : 'Перевірити'}
        </button>
        <button
          type="button"
          className={armed ? 'btn small primary confirm' : 'btn small primary'}
          disabled={!checked || nothingToDo || run.isPending}
          onClick={() => {
            if (!armed) {
              setArmed(true);
              return;
            }
            setArmed(false);
            run.mutate({ kind, dryRun: false, files });
          }}
        >
          {run.isPending && !run.variables.dryRun ? 'Імпортую…' : armed ? 'Точно імпортувати?' : 'Імпортувати'}
        </button>
        <InfoTip label="імпорт з файлу">
          <p>«Перевірити» нічого не пише: показує, скільки рядків нові, скільки вже є в обліку (за ідентифікатором рядка банку) і скільки ви колись видалили.</p>
          <p>«Імпортувати» стає доступним після перевірки й робить те саме, що синхронізація: нові рядки отримують категорії за правилами, рядки, схожі на ручні записи, з ними зв’язуються.</p>
        </InfoTip>
      </div>
      {readError !== null && <p className="note err">{readError}</p>}
      {run.isError && <p className="note err">{describeError(run.error)}</p>}
      {nothingToDo && <p className="note">Усе з цього файлу вже є в обліку — імпортувати нічого.</p>}
      {run.data !== undefined && run.data.kind === kind && <Preview result={run.data} />}
    </div>
  );
};
