# Гроші: notes for agents

Read `docs/handover.md` §6 before touching money logic. The rules there (what counts as
spending, refunds netting into their category, the ФОП currency flow, the deliberate credit
card debt) are encoded in `packages/domain`; change them there, with a test.

## Invariants

- `amount` is always positive; the type gives the sign. Only valuations are signed.
- A balance is the opening plus every row dated on or after the account's `openingDate`.
  Older rows are history for analytics, which is why back-fills never move a balance.
- `toAmount` missing means the same amount arrived; zero means unknown and moves nothing.
- Transfers and valuations never count as spending. Market moves are valuations, never income.
- Every provider line id is prefixed with its source (`mono:…`, `binance:p2p:…`) and is
  globally unique in `externalId` / `toExternalId`. A hand-entered row keeps its own `source`
  when a bank line is linked to it.
- Deleting a synced row records its line ids in `DismissedLine`, so sync does not bring it back.

## Sync pipeline

Providers normalise lines into `StatementItem` and call `ingestStatement`
(`apps/server/src/sync/ingest.ts`). Order matters: outflows first, so incoming own-account
legs find the transfer their outgoing leg created; duplicate checks run last, once every line
had its chance to claim a hand entry. ФОП UAH is a tracked pass-through account, so the
ФОП USD → ФОП UAH → card legs stay exact.

## Conventions

- TypeScript is strict: no `any`, no extra `as`, no suppressions. Node runs the `.ts` files
  directly (type stripping), so only erasable syntax.
- Request and response shapes come from `packages/schema`, never inline types.
- Function names start with a verb; more than two arguments go in an options object.
- Comments explain why, never what. UI text is Ukrainian; code and docs are English.
- Schema changes: edit `apps/server/prisma/schema.prisma`, then `pnpm db:migrate`.
- `pnpm check` must pass before handing work back.
- Never commit `data/`, `secrets/` or `.env`; never log tokens.
