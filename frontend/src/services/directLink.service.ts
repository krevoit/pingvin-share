import {
  CliUploadToken,
  CreatedCliUploadToken,
  CreatedDirectLink,
  DirectLink,
} from "../types/directLink.type";
import api from "./api.service";

const filePath = (shareId: string, fileId: string) =>
  `shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}/direct-links`;

const list = async (shareId: string, fileId: string): Promise<DirectLink[]> =>
  (await api.get(filePath(shareId, fileId))).data;

const create = async (
  shareId: string,
  fileId: string,
  options: { name?: string; expiration: string; maxDownloads?: number },
): Promise<CreatedDirectLink> =>
  (await api.post(filePath(shareId, fileId), options)).data;

const revoke = async (shareId: string, fileId: string, linkId: string) => {
  await api.delete(
    `${filePath(shareId, fileId)}/${encodeURIComponent(linkId)}`,
  );
};

const revokeAll = async (shareId: string, fileId: string) => {
  await api.delete(filePath(shareId, fileId));
};

const listCliTokens = async (): Promise<CliUploadToken[]> =>
  (await api.get("cli/tokens")).data;

const createCliToken = async (options: {
  name?: string;
  expiration: string;
  maxUses: number;
  shareExpiration: string;
}): Promise<CreatedCliUploadToken> =>
  (await api.post("cli/tokens", options)).data;

const deleteCliToken = async (id: string) => {
  await api.delete(`cli/tokens/${encodeURIComponent(id)}`);
};

export default {
  list,
  create,
  revoke,
  revokeAll,
  listCliTokens,
  createCliToken,
  deleteCliToken,
};
