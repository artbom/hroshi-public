import type { Payees, TripSpendKind, TripSummary } from '@hroshi/schema';

import { SectionHead } from '../components/InfoTip.tsx';
import { Nothing } from '../components/Nothing.tsx';
import { ScrollTable } from '../components/ScrollTable.tsx';
import { formatDay, formatEur, formatMonthLong, formatMonthShort, keepTogether, pluralize } from '../format.ts';
import { buildHref, buildTableHref } from '../route.ts';

export const PayeesSection = ({ payees }: { payees: Payees }) => {
  const top = payees.payees[0]?.eur ?? 1;
  return (
    <section>
      <SectionHead
        title="Кому йдуть гроші"
        info={
          <>
            <p>
              Отримувачі за {formatMonthLong(payees.from)} – {formatMonthLong(payees.to)} у євро, мінус повернення й скасовані
              холди. Назви почищено від номерів терміналів і міст («SIXT9616309984,PAREDES,PT» → Sixt), розстрочка Mono
              показана за магазином.
            </p>
            <p>
              Коли банк не назвав отримувача (номер картки, «Щомісячний платіж», порожній опис), записи зібрані як «категорія · без
              назви» й ведуть у «Перевірку», щоб їх назвати.
            </p>
            <p>Натисни, щоб побачити записи.</p>
          </>
        }
      />
      <div className="list">
        {payees.payees.slice(0, 12).map((payee) => (
          <a
            key={payee.key}
            className="row"
            href={payee.unnamed ? buildHref({ view: 'review' }) : buildTableHref({ payee: payee.key, from: payees.from, to: payees.to })}
          >
            <span>
              {payee.unnamed ? (
                <>
                  {keepTogether(payee.name)} · <span className="muted">без назви ({payee.count})</span>
                </>
              ) : (
                keepTogether(payee.name)
              )}
            </span>
            <span className="r num">{formatEur(payee.eur)}</span>
            <span className="s">
              {keepTogether(
                `${payee.unnamed ? 'назвати в «Перевірці» →' : payee.category} · ${pluralize(payee.count, ['раз', 'рази', 'разів'])} · востаннє ${formatDay(payee.lastDate)}`,
              )}
            </span>
            <span className="bar" style={{ gridColumn: '1 / -1', height: 4 }} aria-hidden="true">
              <i style={{ width: `${Math.max(2, (payee.eur / top) * 100)}%`, background: 'var(--s1)' }} />
            </span>
          </a>
        ))}
      </div>
    </section>
  );
};

export const IncomeSourcesSection = ({ payees }: { payees: Payees }) => {
  const top = payees.incomeSources[0]?.eur ?? 1;
  return (
    <section>
      <SectionHead
        title="Звідки дохід"
        info={
          <p>
            Зароблене (зарплата/клієнт, підробіток, продаж речей) за платником. Різні написи одного клієнта в банку («Від: Acme
            LLC», SWIFT-рядок) зведено разом. Повернення й свої перекази сюди не входять.
          </p>
        }
      />
      {payees.incomeSources.length === 0 ? (
        <div className="empty">За цей період доходів немає.</div>
      ) : (
        <div className="cats fixed-amount">
          {payees.incomeSources.slice(0, 8).map((source) => (
            <a key={source.key} className="cat link-row" href={buildTableHref({ payee: source.key, type: 'income', from: payees.from, to: payees.to })}>
              <span title={`${source.category} · ${pluralize(source.count, ['виплата', 'виплати', 'виплат'])}`}>{keepTogether(source.name)}</span>
              <AmountBarInline value={source.eur} max={top} />
              <span className="num">{formatEur(source.eur)}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
};

const AmountBarInline = ({ value, max }: { value: number; max: number }) => (
  <div className="bar">
    <i style={{ width: `${Math.max(2, (value / max) * 100)}%`, background: 'var(--s3)' }} />
  </div>
);

/** Trip tags are written in English slugs; the owner reads Ukrainian. */
const PLACES: Readonly<Record<string, string>> = {
  lisbon: 'Лісабон',
  varna: 'Варна',
  netherlands: 'Нідерланди',
  porto: 'Порту',
  madrid: 'Мадрид',
  paris: 'Париж',
  rome: 'Рим',
  london: 'Лондон',
  kyiv: 'Київ',
  thailand: 'Таїланд',
  andorra: 'Андорра',
  alps: 'Альпи',
};

const formatTag = (tag: string) => {
  const [kind, name] = tag.split(':');
  if (kind !== 'trip' || name === undefined) return tag;
  const [, slug = name, year, month] = /^(.*?)-(\d{4})-(\d{2})$/u.exec(name) ?? [];
  const place = PLACES[slug] ?? `${slug.charAt(0).toLocaleUpperCase('uk')}${slug.slice(1).replaceAll('-', ' ')}`;
  return `✈ ${place}${year === undefined || month === undefined ? '' : `, ${formatMonthShort(`${year}-${month}`)}`}`;
};

const TRIP_KINDS: readonly { kind: TripSpendKind; label: string; color: string }[] = [
  { kind: 'transport', label: 'Дорога', color: 'var(--s1)' },
  { kind: 'stay', label: 'Житло', color: 'var(--s2)' },
  { kind: 'food', label: 'Їжа', color: 'var(--s3)' },
  { kind: 'fun', label: 'Розваги', color: 'var(--s4)' },
  { kind: 'other', label: 'Інше', color: 'var(--s5)' },
  { kind: 'returns', label: 'Повернення', color: 'var(--muted)' },
];

const findKindEur = (tag: TripSummary, kind: TripSpendKind) => tag.kinds.find((entry) => entry.kind === kind)?.eur ?? null;

/** What the trip's money went on, as one bar; returns from friends shorten it rather than drawing below zero. */
const TripBar = ({ tag, top }: { tag: TripSummary; top: number }) => {
  const spent = tag.kinds.filter((entry) => entry.eur > 0);
  const gross = spent.reduce((sum, entry) => sum + entry.eur, 0);
  return (
    <span className="trip-bar" style={{ width: `${Math.max(4, (gross / top) * 100)}%` }} aria-hidden="true">
      {TRIP_KINDS.flatMap(({ kind, color }) => {
        const eur = spent.find((entry) => entry.kind === kind)?.eur;
        return eur === undefined ? [] : [<i key={kind} style={{ width: `${(eur / gross) * 100}%`, background: color }} />];
      })}
    </span>
  );
};

const TripTable = ({ trips }: { trips: readonly TripSummary[] }) => {
  const kinds = TRIP_KINDS.filter(({ kind }) => trips.some((trip) => findKindEur(trip, kind) !== null));
  const top = Math.max(1, ...trips.map((trip) => trip.kinds.reduce((sum, entry) => sum + Math.max(0, entry.eur), 0)));
  return (
    <>
      <ScrollTable className="trip-scroll">
        <div className="tbl trip-table">
          <table>
            <caption className="sr-only">Поїздки поруч: дні, сума, сума за день і на що пішли гроші, у євро.</caption>
            <thead>
              <tr>
                <th scope="col">Поїздка</th>
                <th scope="col" className="r">
                  Днів
                </th>
                <th scope="col" className="r">
                  Разом
                </th>
                <th scope="col" className="r">
                  За день
                </th>
                {kinds.map(({ kind, label }) => (
                  <th key={kind} scope="col" className="r">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trips.map((trip) => (
                <tr key={trip.tag}>
                  <th scope="row">
                    <a className="trip-name" href={buildTableHref({ tag: trip.tag })}>
                      {formatTag(trip.tag)}
                    </a>
                    <span className="small muted trip-dates">
                      {formatDay(trip.from)} – {formatDay(trip.to)}
                    </span>
                    <TripBar tag={trip} top={top} />
                  </th>
                  <td className="r num">{trip.days}</td>
                  <td className="r num">
                    <b>{formatEur(trip.eur)}</b>
                  </td>
                  <td className="r num">{formatEur(trip.eur / trip.days)}</td>
                  {kinds.map(({ kind, label }) => {
                    const eur = findKindEur(trip, kind);
                    return (
                      <td key={kind} className="r num">
                        {eur === null ? <Nothing why={`${label}: у цій поїздці нічого`} /> : formatEur(eur)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ScrollTable>
      <div className="legend">
        {kinds
          .filter(({ kind }) => kind !== 'returns')
          .map(({ kind, label, color }) => (
            <span key={kind}>
              <i style={{ background: color }} />
              {label}
            </span>
          ))}
      </div>
    </>
  );
};

export const TagsSection = ({ tags }: { tags: readonly TripSummary[] }) => {
  const trips = tags.filter((tag) => tag.tag.startsWith('trip:'));
  const labels = tags.filter((tag) => !tag.tag.startsWith('trip:'));
  const top = Math.max(1, ...labels.map((tag) => tag.eur));
  return (
    <section>
      <SectionHead
        title="Поїздки та мітки"
        info={
          <>
            <p>Усе з міткою (наприклад, trip:lisbon-2026-11) у євро, мінус повернення друзів через Splitwise.</p>
            <p>
              На що пішли гроші — за кодом торговця (MCC), бо правила кладуть усю поїздку в «Подорожі»: дорога (авіа, поїзди, таксі,
              оренда авто, пальне), житло, їжа (кафе й магазини), розваги. Записи без коду — «Інше», повернення від друзів —
              «Повернення».
            </p>
            <p>За день — сума поділена на дні від першого запису до останнього, обидва включно.</p>
          </>
        }
      />
      {tags.length === 0 && <div className="empty">За цей період поїздок і міток немає.</div>}
      {trips.length > 0 && <TripTable trips={trips} />}
      {labels.length > 0 && (
        <div className="list">
          {labels.map((tag) => (
            <a key={tag.tag} className="row" href={buildTableHref({ tag: tag.tag })}>
              <span>
                <span className="chip">{formatTag(tag.tag)}</span>
              </span>
              <span className="r num">{formatEur(tag.eur)}</span>
              <span className="s">
                {keepTogether(
                  `${formatDay(tag.from)} – ${formatDay(tag.to)} · ${pluralize(tag.rows, ['запис', 'записи', 'записів'])}${
                    tag.categories.length > 1
                      ? ` · ${tag.categories
                          .slice(0, 3)
                          .map((entry) => `${entry.category} ${formatEur(entry.eur)}`)
                          .join(', ')}`
                      : ''
                  }`,
                )}
              </span>
              <span className="bar" style={{ gridColumn: '1 / -1', height: 4 }} aria-hidden="true">
                <i style={{ width: `${Math.max(2, (Math.max(0, tag.eur) / top) * 100)}%`, background: 'var(--s1)' }} />
              </span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
};
