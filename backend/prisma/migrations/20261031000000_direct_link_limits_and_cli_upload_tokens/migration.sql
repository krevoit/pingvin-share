-- Allow multiple direct download links per file, with optional name,
-- optional expiry, a download limit and a download counter.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_DirectDownloadLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "maxDownloads" INTEGER,
    "downloadCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "lastUsedIp" TEXT,
    "fileId" TEXT NOT NULL,
    CONSTRAINT "DirectDownloadLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_DirectDownloadLink" ("id", "createdAt", "updatedAt", "tokenHash", "expiresAt", "revokedAt", "lastUsedAt", "fileId")
SELECT "id", "createdAt", "updatedAt", "tokenHash", "expiresAt", "revokedAt", "lastUsedAt", "fileId" FROM "DirectDownloadLink";
DROP TABLE "DirectDownloadLink";
ALTER TABLE "new_DirectDownloadLink" RENAME TO "DirectDownloadLink";
CREATE UNIQUE INDEX "DirectDownloadLink_tokenHash_key" ON "DirectDownloadLink"("tokenHash");
CREATE INDEX "DirectDownloadLink_fileId_idx" ON "DirectDownloadLink"("fileId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateTable
CREATE TABLE "CliUploadToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "shareExpiration" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "lastUsedIp" TEXT,
    "creatorId" TEXT NOT NULL,
    CONSTRAINT "CliUploadToken_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "CliUploadToken_tokenHash_key" ON "CliUploadToken"("tokenHash");

-- CreateIndex
CREATE INDEX "CliUploadToken_creatorId_idx" ON "CliUploadToken"("creatorId");
