# Гроші: data model and money rules

The app started as a personal finance tracker built in a chat with Claude as a claude.ai
artifact, then moved to a self-hosted app with automatic bank sync. This file keeps what was
learned along the way. Section 6 (domain rules) is the most important part: it is what makes
the numbers correct, and none of it is obvious from the raw data.

---

## 1. Context

- One owner, a Ukrainian sole proprietor (ФОП) living in the EU. UI language: **Ukrainian**.
- **Money flows across 4 currencies:** UAH, EUR, USD, USDT. Analytics are shown in EUR.
- **How it is used:** no strict budgets. The point is transparency: where money goes, how
  categories change month to month, savings rate, net worth. Soft monthly limits exist but
  stay quiet unless a category is near or over its limit.
- **Income** arrives from clients on the ФОП foreign-currency accounts.

## 4. Data model

```
Account
  id            string   (mono-uah, fop-usd, …)
  name          string   (Ukrainian display name)
  currency      UAH | EUR | USD | USDT
  kind          everyday | credit | cash | investment | receivable
  openingBalance decimal  balance at openingDate (before any tx on/after that date)
  openingDate   date
  creditLimit   decimal?  (credit cards)
  external      json?    { monoAccountId, ibkrAccount, … }
  order         int
  note          string?

Transaction
  id            string
  type          expense | income | transfer | valuation
  date          date
  accountId     → Account
  amount        decimal  ALWAYS POSITIVE (sign comes from type). valuation may be negative
  currency      string   currency of `amount` (= account currency)
  toAccountId   → Account?   (transfer only)
  toAmount      decimal?     (transfer only; amount credited, in the target currency.
                              Missing ⇒ same as amount. 0 is allowed = unknown, no effect)
  category      string?  (expense / income only)
  note          string?  merchant or free text
  tags          string[] e.g. trip:lisbon-2026-11, shared
  source        claude | page | mono | ibkr | binance | import:zenmoney | …
  externalId    string?  unique per source, for dedup (Mono statement item id, etc.)
  createdAt
```

**Balance of an account** = openingBalance + Σ income − Σ expense − Σ outgoing transfer
amount + Σ incoming transfer toAmount (or amount) + Σ valuation.

## 5. Seed data formats (`pnpm seed`)

`pnpm seed [dataDir]` reads four files from `data/` (never committed): `accounts.json`,
`transactions_2026-11.json`, `history_2021-12_to_2026-10.json` and `settings.json`
(the names are fixed in `apps/server/src/seed/handover.ts`).

### 5.1 `accounts.json`

Fields: `id, name, currency, opening, openingDate, order, kind?, bank?, creditLimit?, note?`.
Accounts without `kind` are everyday accounts. `kind: "investment"` are brokers and crypto.
`kind: "receivable"` are debts (positive = someone owes the owner; negative = the owner owes).
A credit card has a negative opening (debt) and a `creditLimit`.

Openings are set so that, together with the first month of transactions, balances match the
banks. Do not "fix" them.

Mapping of Monobank API account types (from `/personal/client-info`):
| Mono type / currency | Tracker account |
|---|---|
| `fop` 980 | `fop-uah`, a pass-through (see §6.2) |
| `fop` 840 | `fop-usd` |
| `fop` 978 | `fop-eur` |
| `white` 980 | `mono-uah` («Mono біла») |
| `platinum` 980 | `mono-credit` (credit card) |
| `black` 840 | `mono-usd` |
| `black` 978 | `mono-eur` |

### 5.2 Transactions file

Same schema as §4 (`amount`, `currency`, `accountId`, `toAccountId`, `toAmount`,
`category`, `note`, `createdAt`, `source`). Imported as is.

### 5.3 History file

Compact rows: `{d, t, a, am, c, cat, n, ta, tam, tc}`
- `d` date, `t` `e`/`i`/`x` (expense/income/transfer), `a` account **name** (string, not id),
  `am` amount (positive), `c` currency, `cat` category, `n` note,
  `ta`/`tam`/`tc` transfer target name/amount/currency (`tam` may be missing = unknown).
- History rows **do not affect balances** (balances start from the openings). They are
  imported as `source: import:zenmoney` for analytics only.
- Account names may include accounts that no longer exist; known names map to ids, the rest
  become archived accounts.
- Months with < 60 rows, or with no income rows, are flagged and excluded from averages.

### 5.4 `settings.json`

`limits` (soft monthly limits in €), `rates` (current units per 1 EUR),
`ratesByYear` (approximate yearly averages, fallback only).

## 6. Domain rules (the important part)

### 6.1 What counts as spending
- Only `expense` rows count. `transfer` never counts. `valuation` never counts.
- Category **«Інвестиції»** (old ZenMoney rows) is **not** spending.
- Refunds and friends' reimbursements are `income` rows **in the same category as the
  original expense** and are subtracted from that category (net). Example: a friend repays
  their share of a dinner → income, category «Кафе і ресторани».
- Real income categories: «Зарплата/клієнт», «Підробіток», «Продаж речей».
  Income «Інше» is ambiguous (often own transfers) and is excluded from both income and
  spending in analytics. «Повернення» (generic reimbursement) reduces total spending.
- Bank cancellations («Скасування …») and holds cancel each other. Net them or skip both
  (example: a car-rental deposit hold, then most of it returned → only the difference is an expense).
- Card payments declined by the bank (e.g. «Ліміт НБУ на витрати з гривневих карток»)
  are not transactions.
- Mono «Розстрочка на картку»: a purchase converted to instalments appears as a refund
  (income), followed by monthly «Погашення наступного платежу …» expenses. Count the
  instalment payments, net out the original purchase (avoid double counting).

### 6.2 ФОП money flow (wartime FX rules in Ukraine)
- Foreign currency on the ФОП cannot be spent directly; it must be sold to UAH first.
- Pattern: **ФОП USD → ФОП UAH (pass-through) → Mono біла**, recorded as exact legs with
  `toAmount` in UAH at the effective rate.
- Credit-card repayments «З гривневого рахунку ФОП» → transfer into `mono-credit`.
- Mono біла «Переказ на картку» to own Mono EUR = buying EUR → transfer
  `mono-uah → mono-eur` with `toAmount` in EUR.

### 6.3 The Mono credit card is deliberate
- Most card spending goes through `mono-credit` (UAH). It is always repaid in full within the
  grace period, so no interest. Owing in UAH is intentional because the hryvnia depreciates.
  **Do not flag the debt as a problem.** Do show it as a negative in net worth.

### 6.4 Crypto, brokers, P2P
- **Binance P2P:** transfers from Mono біла to private people with odd amounts, usually on the
  same day as a ФОП → біла transfer, are P2P USDT purchases. Record as transfer
  `mono-uah → binance` with `toAmount` in USDT from the P2P order history.
- **Binance «Flexible Subscription» / Simple Earn auto-subscribe** = internal move Spot → Earn.
  Ignore. Daily micro amounts are interest being re-subscribed.
- **IBKR** is funded in EUR through an intermediate card: Mono EUR → card → IBKR. Treat all of
  it as an investment transfer.
- Market moves on investment accounts = `valuation` transactions (signed amount), never income.

### 6.5 Cash, Splitwise, people
- Cash rent and utilities: ATM withdrawals = transfer to `cash-eur` (the ATM fee is a separate
  expense). Rent and utilities are expenses from `cash-eur`.
- **Trips:** everything spent during a trip goes to «Подорожі» (food, taxis, fuel, rental),
  tagged with the trip.
- **Splitwise:** the receivable account `splitwise-eur` mirrors the Splitwise balance
  (positive = friends owe the owner). The owner's part of a bill a friend paid is an expense
  from it; the others' part of a bill the owner paid is income on it in the bill's category, so
  spending is the owner's share only. Settling up is a transfer between it and the card, never income.
- **Loans to friends:** receivable accounts. Repayments are transfers into the receiving
  account, decreasing the receivable.
- Gifts collected via one friend → «Подарунки». If a transfer is reduced by a debt the friend
  owed, record the gift at full value plus an income for the debt repayment.

### 6.6 Categories
Expense: Продукти · Кафе і ресторани · Житло · Комуналка і зв'язок · Транспорт · Авто ·
Підписки · Спорт · Здоров'я · Особистий догляд · Подорожі · Покупки · Одяг · Техніка ·
Розваги · Кофішоп · Послуги · Освіта · Подарунки · Благодійність · Податки і збори · Інше.
Income: Зарплата/клієнт · Підробіток · Повернення · Продаж речей · Інше.

Merchant and MCC rules are seeded from `apps/server/src/seed/rules.ts`.

## 8. Integrations

### Monobank (personal API, docs: https://monobank.ua/api-docs/)
- `GET /personal/client-info` (header `X-Token`) → accounts (id, type, currencyCode, balance,
  creditLimit, maskedPan, iban) and jars.
- `GET /personal/statement/{account}/{from}/{to}` (unix seconds) → items: `id, time,
  description, mcc, originalMcc, amount (minor units, signed), operationAmount, currencyCode,
  commissionRate, cashbackAmount, balance, hold, comment, counterName, counterIban, receiptId`.
- Limits: **1 request per 60 s**, max **31 days + 1 h** per statement call, up to 500 items.
- Daily job: for each account fetch the last 7 days, upsert by `externalId`, then categorise
  (rules → MCC → «Інше» + review flag). `balance` from the latest item reconciles the computed
  account balance and raises a mismatch alert.
- Token: env var or secret store only. Never in the repo, never in logs.
- `docs/mono_export.py` is a standalone exporter with paging and rate limits.

### IBKR
Flex Web Service: `SendRequest?t=<token>&q=<queryId>&v=3` → reference code →
`GetStatement`. Configure a Flex Query with Cash Transactions (deposits, dividends,
withholding tax), Trades and Open Positions / NAV.

### Binance
Read-only API key (no trading, no withdrawals, IP-restricted): P2P order history
(`/sapi/v1/c2c/orderMatch/listUserOrderHistory`), deposits and withdrawals, Simple Earn positions
and rewards, balances. P2P orders are matched to Mono біла transfers by date and UAH amount.

### Freedom24
The broker report JSON (`*_all.json`) has `cash_flows.detailed`, `trades.detailed`,
`corporate_actions`, `commissions`, `securities_flows_json`, `account_at_end.account.net_assets`.

## 9. Claude integration (MCP server)
The API exposes an MCP server so chat can add, edit and analyse transactions. Everything is
validated server side. A soft limit is mentioned only when a new expense pushes a category to
≥ 90 % or over, in one short line.
