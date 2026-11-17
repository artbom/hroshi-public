-- CreateEnum
CREATE TYPE "PlannedStatus" AS ENUM ('confirmed', 'ignored');

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "counterparty" TEXT,
ADD COLUMN     "dueDate" DATE;

-- AlterTable
ALTER TABLE "Category" ADD COLUMN     "parent" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "snoozedUntil" DATE;

-- CreateTable
CREATE TABLE "PlannedPayment" (
    "key" TEXT NOT NULL,
    "status" "PlannedStatus" NOT NULL,
    "name" TEXT,
    "amount" DECIMAL(20,8),
    "currency" "Currency",
    "dayOfMonth" INTEGER,
    "accountId" TEXT,
    "category" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlannedPayment_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "PayeeAlias" (
    "key" TEXT NOT NULL,
    "name" TEXT,
    "kind" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayeeAlias_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "InstrumentPrice" (
    "symbol" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "close" DECIMAL(20,8) NOT NULL,
    "currency" "Currency" NOT NULL,
    "source" TEXT NOT NULL,

    CONSTRAINT "InstrumentPrice_pkey" PRIMARY KEY ("symbol","date")
);

-- CreateTable
CREATE TABLE "AllocationTarget" (
    "assetClass" TEXT NOT NULL,
    "share" DECIMAL(6,4) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AllocationTarget_pkey" PRIMARY KEY ("assetClass")
);

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parent_fkey" FOREIGN KEY ("parent") REFERENCES "Category"("name") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlannedPayment" ADD CONSTRAINT "PlannedPayment_category_fkey" FOREIGN KEY ("category") REFERENCES "Category"("name") ON DELETE SET NULL ON UPDATE CASCADE;

