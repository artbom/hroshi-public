-- Revolut line ids carried the bank's account uid, which Enable Banking reissues with every new
-- consent; the history pull after a renewal would then book the whole history a second time. They
-- now carry the ledger account instead: revolut:<uid>:<reference> becomes revolut:<account>:<reference>.
UPDATE "Transaction" AS row
SET "externalId" = 'revolut:' || account."id" || substr(row."externalId", length('revolut:' || account."syncAccountId") + 1)
FROM "Account" AS account
WHERE account."syncSource" = 'revolut'
  AND account."syncAccountId" IS NOT NULL
  AND row."externalId" LIKE 'revolut:' || account."syncAccountId" || ':%';

UPDATE "Transaction" AS row
SET "toExternalId" = 'revolut:' || account."id" || substr(row."toExternalId", length('revolut:' || account."syncAccountId") + 1)
FROM "Account" AS account
WHERE account."syncSource" = 'revolut'
  AND account."syncAccountId" IS NOT NULL
  AND row."toExternalId" LIKE 'revolut:' || account."syncAccountId" || ':%';

UPDATE "DismissedLine" AS line
SET "externalId" = 'revolut:' || account."id" || substr(line."externalId", length('revolut:' || account."syncAccountId") + 1)
FROM "Account" AS account
WHERE account."syncSource" = 'revolut'
  AND account."syncAccountId" IS NOT NULL
  AND line."externalId" LIKE 'revolut:' || account."syncAccountId" || ':%';
