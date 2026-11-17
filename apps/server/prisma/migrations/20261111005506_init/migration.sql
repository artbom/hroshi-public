-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('UAH', 'EUR', 'USD', 'USDT', 'GBP');

-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('everyday', 'credit', 'cash', 'investment', 'receivable');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('expense', 'income', 'transfer', 'valuation');

-- CreateEnum
CREATE TYPE "IncomeRole" AS ENUM ('earning', 'refund', 'netting', 'ignored');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('claude', 'page', 'mono', 'revolut', 'binance', 'ibkr', 'zenmoney');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('running', 'ok', 'error');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "kind" "AccountKind" NOT NULL DEFAULT 'everyday',
    "bank" TEXT,
    "openingBalance" DECIMAL(20,8) NOT NULL,
    "openingDate" DATE NOT NULL,
    "creditLimit" DECIMAL(20,8),
    "order" INTEGER NOT NULL,
    "note" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "passThrough" BOOLEAN NOT NULL DEFAULT false,
    "iban" TEXT,
    "syncSource" "Source",
    "syncAccountId" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "name" TEXT NOT NULL,
    "forExpense" BOOLEAN NOT NULL,
    "forIncome" BOOLEAN NOT NULL,
    "incomeRole" "IncomeRole" NOT NULL DEFAULT 'netting',
    "countsAsSpending" BOOLEAN NOT NULL DEFAULT true,
    "monthlyLimitEur" DECIMAL(12,2),
    "order" INTEGER NOT NULL,
    "archived" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "type" "TransactionType" NOT NULL,
    "date" DATE NOT NULL,
    "accountId" TEXT NOT NULL,
    "amount" DECIMAL(20,8) NOT NULL,
    "currency" "Currency" NOT NULL,
    "toAccountId" TEXT,
    "toAmount" DECIMAL(20,8),
    "toCurrency" "Currency",
    "category" TEXT,
    "note" TEXT,
    "tags" TEXT[],
    "source" "Source" NOT NULL,
    "externalId" TEXT,
    "toExternalId" TEXT,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "reviewReason" TEXT,
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "pattern" TEXT,
    "mcc" INTEGER,
    "accountId" TEXT,
    "category" TEXT,
    "transferToAccountId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FxRate" (
    "date" DATE NOT NULL,
    "currency" "Currency" NOT NULL,
    "perEur" DECIMAL(20,8) NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "FxRate_pkey" PRIMARY KEY ("date","currency")
);

-- CreateTable
CREATE TABLE "YearlyRate" (
    "year" INTEGER NOT NULL,
    "currency" "Currency" NOT NULL,
    "perEur" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "YearlyRate_pkey" PRIMARY KEY ("year","currency")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "source" "Source" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "SyncStatus" NOT NULL DEFAULT 'running',
    "error" TEXT,
    "fetched" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connection" (
    "source" "Source" NOT NULL,
    "sessionId" TEXT,
    "validUntil" TIMESTAMP(3),
    "state" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connection_pkey" PRIMARY KEY ("source")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_iban_key" ON "Account"("iban");

-- CreateIndex
CREATE UNIQUE INDEX "Account_syncSource_syncAccountId_key" ON "Account"("syncSource", "syncAccountId");

-- CreateIndex
CREATE INDEX "Transaction_date_idx" ON "Transaction"("date");

-- CreateIndex
CREATE INDEX "Transaction_accountId_date_idx" ON "Transaction"("accountId", "date");

-- CreateIndex
CREATE INDEX "Transaction_toAccountId_date_idx" ON "Transaction"("toAccountId", "date");

-- CreateIndex
CREATE INDEX "Transaction_needsReview_idx" ON "Transaction"("needsReview");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_source_externalId_key" ON "Transaction"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_source_toExternalId_key" ON "Transaction"("source", "toExternalId");

-- CreateIndex
CREATE INDEX "SyncRun_source_startedAt_idx" ON "SyncRun"("source", "startedAt");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_toAccountId_fkey" FOREIGN KEY ("toAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_category_fkey" FOREIGN KEY ("category") REFERENCES "Category"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_category_fkey" FOREIGN KEY ("category") REFERENCES "Category"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_transferToAccountId_fkey" FOREIGN KEY ("transferToAccountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
