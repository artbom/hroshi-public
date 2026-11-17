-- DropIndex
DROP INDEX "Transaction_source_externalId_key";

-- DropIndex
DROP INDEX "Transaction_source_toExternalId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_externalId_key" ON "Transaction"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_toExternalId_key" ON "Transaction"("toExternalId");

