-- CreateTable
CREATE TABLE "ChatChange" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),

    CONSTRAINT "ChatChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatChange_batchId_idx" ON "ChatChange"("batchId");
