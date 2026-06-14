export type FileUpload = File & { uploadingProgress: number };

export type FileUploadResponse = { id: string; name: string };

export type FileMetaData = {
  id: string;
  name: string;
  size: string;
  directDownloadLink?: {
    expiresAt: Date;
    revokedAt?: Date;
    lastUsedAt?: Date;
  };
};

export type FileListItem = FileUpload | (FileMetaData & { deleted?: boolean });
