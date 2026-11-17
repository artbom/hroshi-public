import type { AccountBalance, Source } from '@hroshi/schema';
import type { ReactNode } from 'react';

import ibkrIcon from '../assets/brands/ibkr.png';
import monoIcon from '../assets/brands/mono.png';
import splitwiseIcon from '../assets/brands/splitwise.png';
import zenmoneyIcon from '../assets/brands/zenmoney.png';
import { useAccounts } from '../queries.ts';

/** How a source is named next to its mark and in the source filter. */
export const SOURCE_LABELS: Readonly<Record<Source, string>> = {
  mono: 'Monobank',
  revolut: 'Revolut',
  binance: 'Binance',
  ibkr: 'IBKR',
  zenmoney: 'ZenMoney',
  claude: 'Claude',
  page: 'вручну',
  splitwise: 'Splitwise',
};

/** Binance and IBKR accounts are filled by valuations, not by a statement sync, so only their bank names say where they live. */
const BANK_SOURCES: ReadonlyMap<string, Source> = new Map([
  ['Monobank', 'mono'],
  ['Revolut', 'revolut'],
  ['Binance', 'binance'],
  ['Interactive Brokers', 'ibkr'],
  ['Splitwise', 'splitwise'],
]);

type MarkAccount = Pick<AccountBalance, 'name' | 'bank' | 'kind' | 'syncSource'>;

export const findAccountSource = (account: MarkAccount): Source | null =>
  account.syncSource ?? BANK_SOURCES.get(account.bank ?? '') ?? null;

const Letters = ({ children }: { children: string }) => (
  <text x="10" y="10.6" textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={800} fill="currentColor">
    {children}
  </text>
);

/** Simple Icons paths (CC0) sit on a 24-unit grid; the mark's box is 20 units with a margin round the logo. */
const SimpleIcon = ({ d }: { d: string }) => <path fill="currentColor" transform="translate(4 4) scale(0.5)" d={d} />;

/** An app icon carries its own background; a glyph is drawn on the brand colour the stylesheet gives the tile. */
type Artwork = { image: string } | { glyph: ReactNode };

/** Where each file came from is listed in `assets/brands/SOURCES.md`. */
const ARTWORK: Readonly<Record<Source, Artwork>> = {
  mono: { image: monoIcon },
  splitwise: { image: splitwiseIcon },
  ibkr: { image: ibkrIcon },
  zenmoney: { image: zenmoneyIcon },
  revolut: { glyph: <SimpleIcon d="M20.9133 6.9566C20.9133 3.1208 17.7898 0 13.9503 0H2.424v3.8605h10.9782c1.7376 0 3.177 1.3651 3.2087 3.043.016.84-.2994 1.633-.8878 2.2324-.5886.5998-1.375.9303-2.2144.9303H9.2322a.2756.2756 0 0 0-.2755.2752v3.431c0 .0585.018.1142.052.1612L16.2646 24h5.3114l-7.2727-10.094c3.6625-.1838 6.61-3.2612 6.61-6.9494zM6.8943 5.9229H2.424V24h4.4704z" /> },
  binance: { glyph: <SimpleIcon d="M16.624 13.9202l2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7154 2.7164L18.5682 12l2.6924-2.7164zm-9.272.001l2.7163 2.6914-2.7164 2.7174v-.001L9.2721 12l2.7164-2.7154zm-9.2722-.001L5.4088 12l-2.6914 2.6924L0 12l2.7164-2.7164zM11.9885.0115l7.353 7.329-2.7174 2.7154-4.6356-4.6356-4.6355 4.6595-2.7174-2.7154 7.353-7.353z" /> },
  claude: { glyph: <SimpleIcon d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" /> },
  page: {
    glyph: (
      <path
        d="M12.6 4.8l2.6 2.6-7.6 7.6-3.4.8.8-3.4zM11 6.4l2.6 2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    ),
  },
};

const CASH_GLYPH = (
  <path d="M3.5 6.5h13v7h-13zM10 8.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2z" fill="none" stroke="currentColor" strokeWidth={1.4} />
);

export type MarkSize = 'sm' | 'md' | 'lg';

/**
 * Marks sit beside the name they stand for, so they stay out of the accessibility tree unless
 * `label` is set: then the mark is the only thing that names the source.
 */
const Mark = ({
  brand,
  title,
  size,
  label = false,
  art,
}: {
  brand: Source | 'other';
  title: string;
  size: MarkSize;
  label?: boolean | undefined;
  art: Artwork;
}) => (
  <span className={`mark ${size}`} data-brand={brand} title={title} {...(label ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true })}>
    {'image' in art ? (
      <img src={art.image} alt="" />
    ) : (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        {art.glyph}
      </svg>
    )}
  </span>
);

/** A source as its own logo: a bank or broker, the ZenMoney import, Claude or a hand entry. */
export const SourceMark = ({
  source,
  size = 'md',
  title = SOURCE_LABELS[source],
  label,
}: {
  source: Source;
  size?: MarkSize;
  title?: string;
  label?: boolean;
}) => (
  <Mark brand={source} title={title} size={size} label={label} art={ARTWORK[source]} />
);

/** An account's bank as a mark; a bank without one of its own gets a neutral monogram, cash a banknote. */
export const AccountMark = ({ account, size = 'md' }: { account: MarkAccount; size?: MarkSize }) => {
  const source = findAccountSource(account);
  if (source !== null) return <SourceMark source={source} size={size} />;
  const owner = account.bank ?? account.name;
  return (
    <Mark
      brand="other"
      title={owner}
      size={size}
      art={{ glyph: account.kind === 'cash' ? CASH_GLYPH : <Letters>{owner.slice(0, 1).toUpperCase()}</Letters> }}
    />
  );
};

/** For lists that carry only the account id; the accounts query is already cached by every screen. */
export const AccountIdMark = ({ accountId, size = 'md' }: { accountId: string; size?: MarkSize }) => {
  const account = useAccounts().data?.find((candidate) => candidate.id === accountId);
  return account === undefined ? <span className={`mark ${size}`} data-brand="other" aria-hidden="true" /> : <AccountMark account={account} size={size} />;
};
