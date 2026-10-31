export type DirectLink = {
  id: string;
  name: string | null;
  createdAt: string;
  expiresAt: string | null;
  maxDownloads: number | null;
  downloadCount: number;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
};

export type CreatedDirectLink = DirectLink & { token: string; path: string };

export type CliUploadToken = {
  id: string;
  name: string | null;
  createdAt: string;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  shareExpiration: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
};

export type CreatedCliUploadToken = CliUploadToken & { token: string };

export const directLinkStatus = (link: DirectLink) => {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && new Date(link.expiresAt).getTime() <= Date.now())
    return "expired";
  if (link.maxDownloads !== null && link.downloadCount >= link.maxDownloads)
    return "used-up";
  return "active";
};

export const cliTokenStatus = (token: CliUploadToken) => {
  if (new Date(token.expiresAt).getTime() <= Date.now()) return "expired";
  if (token.maxUses !== null && token.useCount >= token.maxUses)
    return "used-up";
  return "active";
};
