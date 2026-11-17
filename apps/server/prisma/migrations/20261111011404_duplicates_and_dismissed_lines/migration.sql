-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "duplicateOfId" TEXT;

-- CreateTable
CREATE TABLE "DismissedLine" (
    "externalId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DismissedLine_pkey" PRIMARY KEY ("externalId")
);

