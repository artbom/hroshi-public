import {
  classifyTransaction,
  convertToEur,
  detectPayeeKind,
  findBankText,
  findPayeeText,
  findSimilarPayees,
  type MerchantName,
  normalizeMerchant,
  toMerchantKey,
  UNTITLED_MERCHANT,
} from '@hroshi/domain';
import {
  type PayeeEntry,
  PayeeDirectorySchema,
  type PayeeKind,
  PayeeKindSchema,
  SavedPayeeAliasesSchema,
  SavePayeeAliasesSchema,
  type Transaction,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { prisma } from '../db.ts';
import { loadLedger } from '../ledger.ts';

type Tally = Omit<PayeeEntry, 'members' | 'category' | 'kind' | 'kindByOwner'> & {
  first: Transaction;
  members: Map<string, { name: string; count: number }>;
  categories: Map<string, number>;
};

const UNTITLED_KEY = toMerchantKey(UNTITLED_MERCHANT);

/** Bank texts repeat a lot; each is normalised once per request. */
const createNameCache = () => {
  const names = new Map<string | null, MerchantName>();
  return (text: string | null): MerchantName => {
    const cached = names.get(text);
    if (cached !== undefined) return cached;
    const name = normalizeMerchant(text);
    names.set(text, name);
    return name;
  };
};

const roundCents = (value: number) => Math.round(value * 100) / 100;

const pickMainCategory = (categories: ReadonlyMap<string, number>): string | null =>
  [...categories].toSorted((left, right) => right[1] - left[1])[0]?.[0] ?? null;

export const payeeRoutes: FastifyPluginAsyncZod = async (app) => {
  /** Every payee with a name, as the rest of the app groups it, with the bank spellings it is made of. */
  app.get('/payees/directory', { schema: { response: { 200: PayeeDirectorySchema } } }, async () => {
    const [ledger, aliases] = await Promise.all([loadLedger(prisma), prisma.payeeAlias.findMany()]);
    const aliasNames = new Map(aliases.flatMap((alias) => (alias.name === null ? [] : [[alias.key, alias.name]])));
    const ownerKinds = new Map(
      aliases.flatMap((alias) => {
        const kind = PayeeKindSchema.safeParse(alias.kind).data;
        return kind === undefined ? [] : [[alias.key, kind]];
      }),
    );
    const nameOf = createNameCache();
    const tallies = new Map<string, Tally>();

    for (const transaction of ledger.transactions) {
      if (transaction.type !== 'expense' && transaction.type !== 'income') continue;
      const bank = nameOf(findBankText(transaction));
      if (bank.key === UNTITLED_KEY) continue;
      const { key, name } = nameOf(findPayeeText(transaction));
      const tally: Tally = tallies.get(key) ?? {
        key,
        name,
        alias: aliasNames.get(bank.key) ?? null,
        count: 0,
        spentEur: 0,
        receivedEur: 0,
        lastDate: transaction.date,
        first: transaction,
        members: new Map(),
        categories: new Map(),
      };
      tallies.set(key, tally);
      // A name shared with an untouched spelling merges into it, so any renamed member marks the payee as renamed.
      tally.alias ??= aliasNames.get(bank.key) ?? null;
      const effect = classifyTransaction(transaction, ledger.policies);
      const eur = convertToEur({ transaction, fx: ledger.fx }) ?? 0;
      if (effect.kind === 'spend') tally.spentEur += effect.sign * eur;
      else if (effect.kind === 'refund') tally.spentEur -= eur;
      else if (effect.kind === 'income') tally.receivedEur += eur;
      tally.count += 1;
      if (transaction.date > tally.lastDate) tally.lastDate = transaction.date;
      if (transaction.category !== null) tally.categories.set(transaction.category, (tally.categories.get(transaction.category) ?? 0) + 1);
      const member = tally.members.get(bank.key) ?? { name: bank.name, count: 0 };
      tally.members.set(bank.key, { ...member, count: member.count + 1 });
    }

    const payees = [...tallies.values()].map(({ first, members, categories, ...tally }): PayeeEntry => {
      const owner = [...members.keys()].map((member) => ownerKinds.get(member)).find((kind): kind is PayeeKind => kind !== undefined);
      return {
        ...tally,
        spentEur: roundCents(tally.spentEur),
        receivedEur: roundCents(tally.receivedEur),
        kind: owner ?? detectPayeeKind({ text: findBankText(first), mcc: first.mcc }),
        kindByOwner: owner !== undefined,
        category: pickMainCategory(categories),
        // Only a renamed payee needs its spellings listed; any other is its own single spelling.
        members:
          tally.alias === null
            ? []
            : [...members].map(([key, member]) => ({ key, ...member })).toSorted((left, right) => right.count - left.count),
      };
    });
    return { payees: payees.toSorted((left, right) => right.count - left.count), similar: findSimilarPayees(payees) };
  });

  app.put(
    '/payee-aliases',
    { schema: { body: SavePayeeAliasesSchema, response: { 200: SavedPayeeAliasesSchema } } },
    async (request) => {
      const { keys, name, kind } = request.body;
      const change = { ...(name === undefined ? {} : { name }), ...(kind === undefined ? {} : { kind }) };
      const saved = await prisma.$transaction(
        keys.map((key) =>
          prisma.payeeAlias.upsert({ where: { key }, create: { key, name: name ?? null, kind: kind ?? null }, update: change }),
        ),
      );
      // A spelling with neither a name nor a kind is back to what the bank says.
      await prisma.payeeAlias.deleteMany({ where: { key: { in: keys }, name: null, kind: null } });
      return { updated: saved.length };
    },
  );
};
