# Гроші

Personal finance ledger for one person and four currencies (UAH, EUR, USD, USDT), with
daily sync from Monobank, Revolut (Enable Banking), Binance and IBKR. It grew out of a
claude.ai tracker artifact; `docs/handover.md` explains the
data and, in §6, the money rules that make the numbers right.

## Run it

```bash
cp .env.example .env          # fill in the sources you use
pnpm install
pnpm db:up                    # Postgres on 127.0.0.1:5442
pnpm db:migrate
pnpm seed                     # optional: your own data/, format in docs/handover.md §5
pnpm dev                      # API on :4300, web on :4310
```

Home lab: `docker compose up -d --build` runs Postgres, the API (serving the built web app
on :4300) and the worker. Put it behind Tailscale or Cloudflare Access; there is no login.

Raspberry Pi: `scripts/deploy-pi.sh` builds the arm64 image on the Mac, loads it into the Pi's
Docker over SSH and restarts the stack there (`PI=user@host` to target another box). Compose
runs on the Mac against the Pi, so the Pi needs only Docker; `.env` stays on the Mac and the
script copies `secrets/` and seeds `data/brokers`. Deploy again after every change. Only one
machine may run the syncs: Monobank rate-limits per token.

Personal data stays out of git: `data/` (handover files, exports, DB backups), `secrets/`
(private keys) and `.env` are ignored.

## Sources

| Source | How | Needs |
|---|---|---|
| Monobank | `/personal/statement`, last 7 days, daily 06:00 | `MONO_TOKEN` from api.monobank.ua |
| Revolut | Enable Banking (PSD2), last 10 days, daily 06:20 | an Enable Banking app, see below |
| Binance | P2P orders (30 days) + wallet value, daily 06:30 | read-only API key, IP-restricted |
| IBKR | Flex Web Service: deposits + NAV, daily 06:40 | Flex token and query id |
| Splitwise | expenses and settle-ups since the account opened, daily 06:50 | `SPLITWISE_SESSION` and `SPLITWISE_USER_CREDENTIALS` cookies from a signed-in browser |

Each run is listed on the «Синхронізація» tab with counts, errors and balance mismatches.
`pnpm --filter @hroshi/server cli sync <source>` runs one by hand.

Back-fill from files:

```bash
pnpm --filter @hroshi/server cli import:mono ../../data/mono/mono_export.json
pnpm --filter @hroshi/server cli import:binance ~/Downloads/binance_export
```

### Enable Banking (Revolut)

1. Sign in at enablebanking.com, open the control panel, register a **production**
   application. Let the browser generate the key and save the downloaded `.pem` as
   `secrets/enable-banking.pem`. Add the redirect URL from `.env`
   (`http://localhost:4300/api/connections/revolut/callback`, or your Tailscale host).
2. Use «Activate by linking accounts» and link your Revolut account. A restricted app sees
   only linked accounts, which is all a personal tracker needs.
3. Put the application id into `ENABLE_BANKING_APP_ID`. Check how Revolut is listed with
   `pnpm --filter @hroshi/server cli eb:aspsps ES` and adjust `ENABLE_BANKING_ASPSP_*`.
4. «Синхронізація» → «Підключити Revolut», approve in Revolut. Consent lasts up to
   180 days; the tab shows when it runs out.

Renewing can't be automated: EU rules (RTS 2018/389 Art. 10a) make the owner confirm in the bank
at least every 180 days. The bot makes it one tap: 14, 7, 3 and 1 days before the end, and once on
the day, it sends «🔄 Поновити Revolut». The button answers with a fresh link to Revolut; after
approving, the browser lands on the redirect address. If nothing listens there (`https://localhost`),
paste that address to the bot and it finishes the renewal and pulls what was missed. With an HTTPS
address for the Pi (for example `tailscale serve`) registered in Enable Banking as
`ENABLE_BANKING_REDIRECT_URL`, the callback finishes it without the paste. A consent the bank
closes early is caught on the next sync and gets the same reminder. Revolut line ids are keyed on
the ledger account, not the bank's per-consent account uid, so a renewal never books history twice.

A sync that fails for any other reason says so in Telegram. Monobank's personal token doesn't
expire; a refused token and a temporary IP block are told apart.

### Splitwise

The `splitwise-eur` account (one per currency) mirrors what Splitwise says friends owe, and the
sync checks it against Splitwise every morning. Spending counts only the owner's share: a bill they paid
by card stays the bank's expense, and the friends' part comes back as income in the same category
and trip; a bill a friend paid is the owner's part as an expense from the account. A settle-up turns the
bank transfer, once it is in, into a transfer to or from the account. What Splitwise owed before
the account's opening date is its opening balance. The chat bot can add expenses and settle-ups
in Splitwise too; «Скасувати» deletes them there again.

### IBKR Flex query

Create an Activity Flex Query with **Cash Transactions** (deposits, dividends, withholding)
and **Net Asset Value (NAV) in Base**, XML format, then enable the Flex Web Service to get a
token. Deposits fill in the dollar amount of the transfer that funded them; NAV becomes a
daily valuation.

## Telegram digest

Every morning at 08:00 the worker sends the month's budget up to yesterday: what is spent and
left in total and per orientir category, where the month is heading (monthly payments still due
plus the everyday pace), and on the 1st what was put aside against the goal. The budget is the
usual income (the average of the three complete months before) minus the savings goal; the
orientir categories each count against their own limit, every other category against what the
budget leaves after them. Set the goal on the categories page or ask the bot («відкладаю 3500
доларів»); `cli digest:day [YYYY-MM-DD] [--send]` renders it by hand.

Every Monday at 09:00 the worker sends an infographic of the last week, and on the 1st one of
the last month. Spending is compared with a usual week (the 8 before) or month (the 6 before),
with top categories, the biggest purchases and merchants, soft limits near their end and sync
health. Card holds released after the period ends are netted out.

1. Create a bot with @BotFather and put its token into `TELEGRAM_BOT_TOKEN`.
2. Send the bot `/start`, then `pnpm --filter @hroshi/server cli telegram:chats` and put your
   chat id into `TELEGRAM_CHAT_ID`.
3. Try it: `cli digest:week --send` or `cli digest:month [YYYY-MM] --send` (without `--send` the
   picture is only saved to `data/digests/`).

## Telegram chat

Write to the same bot in plain Ukrainian: «заплатив готівкою 20 € за каву», «перенеси вчорашні
витрати в Лісабоні в Подорожі», «що висить у перевірці?». The `bot` service runs Claude Code
headless with the owner's own Claude subscription. Claude reaches the ledger only through the
app's MCP server (`/api/mcp`), with no shell or files. Only `TELEGRAM_CHAT_ID` gets an answer, and
a follow-up within 30 minutes continues the conversation (`/new` starts over).

Voice notes work too: the bot transcribes them on the Pi with whisper.cpp (large-v3-turbo, Ukrainian),
shows what it heard and goes on as with text; nothing leaves the box. `scripts/deploy-pi.sh` fetches
the model into `data/models` once. Photos go to Claude as they are: a receipt or a bank screenshot,
with or without a caption, becomes the same kind of request. Claude can also send pictures: the digest infographic for any
week or month («скинь звіт за жовтень») and a chart drawn from the app's own numbers («намалюй
net worth за рік»).

Every write is logged in `ChatChange` with whole-row snapshots. The «Скасувати» button under a
reply puts the rows back exactly, bank links included, and refuses when a row changed after the
message. Sign in once per volume: `docker exec -it hroshi-bot-1 claude auth login` (on the Pi:
`ssh -t pi@pi.local docker exec -it hroshi-bot-1 claude auth login`). Telegram allows one
poller per bot token, so run the stack on one machine only.

## Layout

- `packages/schema`: Zod contracts shared by the API and the web app.
- `packages/domain`: the money rules as pure functions (balances, FX, what counts as
  spending, monthly aggregates, net worth, rule matching), unit-tested.
- `apps/server`: Fastify API, Prisma, the sync pipeline (`src/sync`), the worker, the CLI.
- `apps/web`: Vite + React UI, in Ukrainian.

`pnpm check` runs typecheck, lint and tests.
