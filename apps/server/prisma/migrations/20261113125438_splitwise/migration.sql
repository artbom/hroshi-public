-- CreateEnum
CREATE TYPE "ChatSplitwiseAction" AS ENUM ('created', 'deleted');

-- AlterEnum
ALTER TYPE "Source" ADD VALUE 'splitwise';

-- CreateTable
CREATE TABLE "ChatSplitwiseChange" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "action" "ChatSplitwiseAction" NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "ChatSplitwiseChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatSplitwiseChange_batchId_idx" ON "ChatSplitwiseChange"("batchId");
