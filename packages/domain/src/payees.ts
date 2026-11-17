import type { IncomeSource, Month, Payee, PayeeEntry } from '@hroshi/schema';

import { type CategoryPolicies, classifyTransaction } from './classify.ts';
import { convertToEur, type FxConverter } from './fx.ts';
import { describePayee, findPayeeText, type PayeeName, normalizeMerchant, toMerchantKey, UNTITLED_MERCHANT } from './merchants.ts';
import { toMonth } from './months.ts';
import type { LedgerTransaction } from './types.ts';

type Tally = PayeeName & { eur: number; count: number; lastDate: string; byCategory: Map<string, number>; months: Set<Month> };

const createTally = (merchant: PayeeName): Tally => ({
  ...merchant,
  eur: 0,
  count: 0,
  lastDate: '',
  byCategory: new Map(),
  months: new Set(),
});

const addToTally = ({ tally, eur, category, date }: { tally: Tally; eur: number; category: string; date: string }) => {
  tally.eur += eur;
  tally.count += 1;
  if (date > tally.lastDate) tally.lastDate = date;
  tally.byCategory.set(category, (tally.byCategory.get(category) ?? 0) + eur);
  tally.months.add(toMonth(date));
};

const pickMainCategory = (tally: Tally) =>
  [...tally.byCategory].toSorted((left, right) => right[1] - left[1])[0]?.[0] ?? '';

const MIN_PAYEE_EUR = 0.5;

/** Where the money went, net of refunds and released holds, so a cancelled car-rental hold is not a top payee. */
export const rankPayees = ({
  months,
  transactions,
  policies,
  fx,
  limit = 20,
}: {
  months: readonly Month[];
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
  limit?: number;
}): Payee[] => {
  const inRange = new Set(months);
  const tallies = new Map<string, Tally>();

  for (const transaction of transactions) {
    if (!inRange.has(toMonth(transaction.date))) continue;
    const effect = classifyTransaction(transaction, policies);
    if (effect.kind !== 'spend') continue;
    const eur = convertToEur({ transaction, fx });
    if (eur === null) continue;
    const merchant = describePayee({ text: findPayeeText(transaction), category: effect.category });
    const tally = tallies.get(merchant.key) ?? createTally(merchant);
    tallies.set(merchant.key, tally);
    addToTally({ tally, eur: effect.sign * eur, category: effect.category, date: transaction.date });
  }

  return [...tallies.values()]
    .filter((tally) => tally.eur >= MIN_PAYEE_EUR)
    .toSorted((left, right) => right.eur - left.eur)
    .slice(0, limit)
    .map((tally) => ({
      key: tally.key,
      name: tally.name,
      unnamed: tally.unnamed,
      eur: tally.eur,
      count: tally.count,
      category: pickMainCategory(tally),
      lastDate: tally.lastDate,
    }));
};

/** A payer named in full elsewhere: "SWIFT платіж … WITHACME LLC…" belongs to "Acme LLC". */
const MIN_FOLDING_KEY_LENGTH = 5;

/**
 * Earnings by who paid them. Bank descriptions of the same client vary ("Від: Acme LLC",
 * "ACME LLC 1 MAIN STREET", a SWIFT reference), so a description that contains a
 * shorter payer's name joins that payer.
 */
export const rankIncomeSources = ({
  months,
  transactions,
  policies,
  fx,
}: {
  months: readonly Month[];
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
}): IncomeSource[] => {
  const inRange = new Set(months);
  const earnings = transactions.flatMap((transaction) => {
    if (!inRange.has(toMonth(transaction.date))) return [];
    if (classifyTransaction(transaction, policies).kind !== 'income') return [];
    const eur = convertToEur({ transaction, fx });
    if (eur === null) return [];
    const category = transaction.category ?? '';
    const merchant =
      (findPayeeText(transaction) ?? '').trim() === ''
        ? { key: toMerchantKey(`${UNTITLED_MERCHANT} ${category}`), name: `${UNTITLED_MERCHANT} (${category})`, unnamed: true }
        : { ...normalizeMerchant(findPayeeText(transaction)), unnamed: false };
    const text = toMerchantKey([transaction.note, transaction.bankText].filter(Boolean).join(' ')).replaceAll(' ', '');
    return [{ transaction, eur, category, merchant, text }];
  });

  const payers = [...new Map(earnings.map(({ merchant }) => [merchant.key, merchant])).values()]
    .filter((merchant) => merchant.key.length >= MIN_FOLDING_KEY_LENGTH)
    .toSorted((left, right) => left.key.length - right.key.length);

  const tallies = new Map<string, Tally>();
  for (const { transaction, eur, category, merchant, text } of earnings) {
    const payer = payers.find((candidate) => text.includes(candidate.key.replaceAll(' ', ''))) ?? merchant;
    const tally = tallies.get(payer.key) ?? createTally(payer);
    tallies.set(payer.key, tally);
    addToTally({ tally, eur, category, date: transaction.date });
  }

  return [...tallies.values()]
    .toSorted((left, right) => right.eur - left.eur)
    .map((tally) => ({
      key: tally.key,
      name: tally.name,
      eur: tally.eur,
      count: tally.count,
      category: pickMainCategory(tally),
      lastDate: tally.lastDate,
      months: tally.months.size,
    }));
};

/** Words that tell where or what legal form, never who: «Condis Girona» is «Condis», «Acme LLC» is «Acme». */
const PLACE_AND_FORM_WORDS: ReadonlySet<string> = new Set(
  (
    'SL SLU SA SAU LLC LTD GMBH INC BV SRL SAS CO COM WWW LIMITED PLC AG AB OY ТОВ ФОП ПП ПАТ АТ ' +
    'BARCELONA BCN MADRID LISBOA LISBON PORTO VALENCIA GIRONA MALAGA SEVILLA KYIV KIEV КИЇВ КИІВ КИЕВ КИЄВ LVIV ЛЬВІВ ' +
    'ODESA ОДЕСА ESPANA SPAIN ES ESP PT PRT UA UKR UKRAINE DE NL IE GB UK US USA LONDON PARIS BERLIN AMSTERDAM DUBLIN ' +
    'WARSZAWA KRAKOW'
  ).split(' '),
);

/** Words that name a kind of place, not a brand: «Kafe Avi» and «Kafe Panorama» are not one payee. */
const GENERIC_WORDS: ReadonlySet<string> = new Set(
  (
    'LA EL LOS LAS LE THE BAR CAFE CAFETERIA RESTAURANTE RESTAURANT RESTORAN FARMACIA PHARMACY HOTEL SUPERMERCADO ' +
    'SUPERMERCADOS SUPERMERCAT SUPERMARKET SUPER MERCADO MERCAT SHOP STORE TIENDA PARKING TAXI PAGO COMPRA RETURN MAGAZIN ' +
    'MAGAZYN MAAGAZIN PRODUKTI PRODUKTY ALIMENTACION ALIMENTACIO KAFE KAVA BENZINERA GASOLINERA ESTACIO AJUNTAMENT APP ' +
    'DISCOUNT TRAVEL SQ МАГАЗИН АПТЕКА КАФЕ РЕСТОРАН ОПЛАТА ПЕРЕКАЗ ПОПОВНЕННЯ ПОГАШЕННЯ ДОСТРОКОВЕ ВИПУСК ПАРКІНГ ПАРКОВКА ГАЗ'
  ).split(' '),
);

/** A tail that turns a brand into another service: Uber and Uber Eats, Amazon and Amazon Prime. */
const OTHER_SERVICE_WORDS: ReadonlySet<string> = new Set(['FOOD', 'EATS', 'PRIME', 'MUSIC', 'TV', 'NETWORK']);

/** A short name stands for longer ones ending in it («Електросамокати Bolt») only when it is the busier, established payee. */
const MIN_SUFFIX_HUB_ROWS = 5;
const MIN_STEM_LENGTH = 3;

export type SimilarPayeeCandidate = Pick<PayeeEntry, 'key' | 'kind' | 'count' | 'category'>;

type Cluster = { members: SimilarPayeeCandidate[]; words: string[]; count: number; category: string | null; person: boolean };

const findStemWords = (key: string): string[] => {
  const words = key.split(' ').filter((word) => !PLACE_AND_FORM_WORDS.has(word));
  return words.length === 0 ? key.split(' ') : words;
};

const startsWith = (words: readonly string[], head: readonly string[]) => head.every((word, index) => words[index] === word);
const endsWith = (words: readonly string[], tail: readonly string[]) =>
  tail.every((word, index) => words[words.length - tail.length + index] === word);

/** The hub a longer name joins: its brand at the start (or, for a busy brand, at the end), the shortest such brand first. */
const findHub = ({ cluster, hubs }: { cluster: Cluster; hubs: readonly Cluster[] }): Cluster | undefined =>
  hubs
    .filter((hub) => {
      if (hub === cluster || hub.words.length >= cluster.words.length) return false;
      const prefix = startsWith(cluster.words, hub.words);
      const suffix = !prefix && endsWith(cluster.words, hub.words) && hub.count >= MIN_SUFFIX_HUB_ROWS && hub.count >= cluster.count;
      if (!prefix && !suffix) return false;
      const extra = prefix ? cluster.words.slice(hub.words.length) : cluster.words.slice(0, -hub.words.length);
      // Two payees the owner books to different categories are different things, whatever the bank calls them.
      const sameCategory = hub.category === null || cluster.category === null || hub.category === cluster.category;
      return sameCategory && !extra.some((word) => OTHER_SERVICE_WORDS.has(word));
    })
    .toSorted((left, right) => left.words.length - right.words.length || right.count - left.count)[0];

/**
 * Payees that are probably one: the same name once case, punctuation, spaces, a city or a legal form
 * are set aside («UberEATS» and «Uber Eats», «Condis» and «CONDIS BARCELONA»), or a longer name that
 * starts with a known brand («Condis Bac de Roda»). People only match on the whole name. Each group
 * lists keys busiest first; nothing is merged until the owner says so.
 */
export const findSimilarPayees = (entries: readonly SimilarPayeeCandidate[]): string[][] => {
  const byStem = Map.groupBy(
    entries.filter((entry) => !entry.key.startsWith('CARD ') && (entry.kind === 'merchant' || entry.kind === 'person')),
    (entry) => {
      const stem = findStemWords(entry.key).join('');
      return `${entry.kind}:${stem.length >= MIN_STEM_LENGTH ? stem : entry.key}`;
    },
  );
  const clusters = [...byStem.values()].map((group): Cluster => {
    const members = group.toSorted((left, right) => right.count - left.count);
    const [busiest] = members;
    return {
      members,
      words: findStemWords(busiest?.key ?? ''),
      count: members.reduce((sum, member) => sum + member.count, 0),
      category: busiest?.category ?? null,
      person: busiest?.kind === 'person',
    };
  });
  const hubs = clusters.filter(
    (cluster) =>
      !cluster.person &&
      cluster.words.length <= 2 &&
      !GENERIC_WORDS.has(cluster.words[0] ?? '') &&
      cluster.words.join('').length >= MIN_STEM_LENGTH,
  );
  const hubOf = new Map(clusters.map((cluster) => [cluster, cluster.person ? undefined : findHub({ cluster, hubs })]));
  const groups = new Map<Cluster, SimilarPayeeCandidate[]>();
  for (const cluster of clusters) {
    const hub = hubOf.get(cluster);
    // One level only: a two-word brand that itself starts with a one-word one joins that one.
    const root = (hub === undefined ? undefined : (hubOf.get(hub) ?? hub)) ?? cluster;
    groups.set(root, [...(groups.get(root) ?? []), ...cluster.members]);
  }
  return [...groups.values()]
    .filter((members) => members.length > 1)
    .map((members) => members.toSorted((left, right) => right.count - left.count))
    .toSorted((left, right) => right.reduce((sum, entry) => sum + entry.count, 0) - left.reduce((sum, entry) => sum + entry.count, 0))
    .map((members) => members.map((member) => member.key));
};
