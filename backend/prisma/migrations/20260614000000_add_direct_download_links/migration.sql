-- CreateTable
CREATE TABLE "DirectDownloadLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "lastUsedAt" DATETIME,
    "fileId" TEXT NOT NULL,
    CONSTRAINT "DirectDownloadLink_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "File" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "DirectDownloadLink_tokenHash_key" ON "DirectDownloadLink"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "DirectDownloadLink_fileId_key" ON "DirectDownloadLink"("fileId");
