import type { MonoAccount, MonoStatementItem } from './client.ts';

const PERSON_TRANSFER_MCC = 4829;
/** Both legs of a move between own cards carry the same second; allow for clock skew. */
const PAIR_WINDOW_S = 120;

type Line = { monoAccountId: MonoAccount['id']; item: MonoStatementItem };

/** One leg's amount is the other's operation amount: −8 000 ₴ on the white card is +154.52 € "З Білої картки". */
const areLegs = (outgoing: MonoStatementItem, incoming: MonoStatementItem) =>
  outgoing.amount < 0 &&
  incoming.amount > 0 &&
  Math.abs(incoming.time - outgoing.time) <= PAIR_WINDOW_S &&
  (incoming.operationAmount === -outgoing.amount || incoming.amount === -outgoing.operationAmount);

/**
 * Mono leaves the IBAN off transfers between the owner's own cards ("З Білої картки",
 * "Переказ на картку"). Pairing the two legs and filling in each other's IBAN lets the
 * ingestion treat them like any other own-account transfer.
 */
export const pairOwnCardTransfers = ({
  monoAccounts,
  statements,
}: {
  monoAccounts: readonly MonoAccount[];
  statements: ReadonlyMap<MonoAccount['id'], MonoStatementItem[]>;
}): Map<MonoAccount['id'], MonoStatementItem[]> => {
  const ibans = new Map(monoAccounts.map((account) => [account.id, account.iban]));
  const orphans: Line[] = [...statements].flatMap(([monoAccountId, items]) =>
    items
      .filter((item) => item.mcc === PERSON_TRANSFER_MCC && item.counterIban === undefined)
      .map((item) => ({ monoAccountId, item })),
  );
  const counterIbans = new Map<MonoStatementItem['id'], string>();

  for (const outgoing of orphans) {
    const incoming = orphans.find(
      (candidate) =>
        candidate.monoAccountId !== outgoing.monoAccountId &&
        !counterIbans.has(candidate.item.id) &&
        areLegs(outgoing.item, candidate.item),
    );
    const outgoingIban = ibans.get(outgoing.monoAccountId);
    const incomingIban = incoming === undefined ? undefined : ibans.get(incoming.monoAccountId);
    if (incoming === undefined || outgoingIban === undefined || incomingIban === undefined) continue;
    counterIbans.set(outgoing.item.id, incomingIban);
    counterIbans.set(incoming.item.id, outgoingIban);
  }

  return new Map(
    [...statements].map(([monoAccountId, items]) => [
      monoAccountId,
      items.map((item) => {
        const counterIban = counterIbans.get(item.id);
        return counterIban === undefined ? item : { ...item, counterIban };
      }),
    ]),
  );
};

const FOP_SALE = /^На гривневий рахунок ФОП/u;

/**
 * Older Mono statements name the final card on a ФОП currency sale ("На гривневий рахунок ФОП
 * для переказу на картку") although the money still passes through ФОП UAH, whose own two lines
 * are in the statement too. Pointing the sale at ФОП UAH keeps one chain of transfers instead of
 * booking the dollars as leaving twice.
 */
export const routeFopSalesThroughUah = ({
  monoAccounts,
  statements,
}: {
  monoAccounts: readonly MonoAccount[];
  statements: ReadonlyMap<MonoAccount['id'], MonoStatementItem[]>;
}): Map<MonoAccount['id'], MonoStatementItem[]> => {
  const fopUah = monoAccounts.find((account) => account.type === 'fop' && account.currencyCode === 980);
  const currencyFops = new Set(
    monoAccounts.filter((account) => account.type === 'fop' && account.currencyCode !== 980).map((account) => account.id),
  );
  return new Map(
    [...statements].map(([monoAccountId, items]) => [
      monoAccountId,
      fopUah === undefined || !currencyFops.has(monoAccountId)
        ? items
        : items.map((item) => (FOP_SALE.test(item.description) ? { ...item, counterIban: fopUah.iban } : item)),
    ]),
  );
};
