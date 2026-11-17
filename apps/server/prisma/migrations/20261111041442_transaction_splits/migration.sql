-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "splitOfId" TEXT;

-- CreateIndex
CREATE INDEX "Transaction_splitOfId_idx" ON "Transaction"("splitOfId");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_splitOfId_fkey" FOREIGN KEY ("splitOfId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

