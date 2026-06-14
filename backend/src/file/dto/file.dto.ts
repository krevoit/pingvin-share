import { Expose, plainToClass, Type } from "class-transformer";
import { ShareDTO } from "src/share/dto/share.dto";

export class DirectDownloadLinkDTO {
  @Expose()
  expiresAt: Date;

  @Expose()
  revokedAt?: Date;

  @Expose()
  lastUsedAt?: Date;
}

export class FileDTO {
  @Expose()
  id: string;

  @Expose()
  name: string;

  @Expose()
  size: string;

  @Expose()
  @Type(() => DirectDownloadLinkDTO)
  directDownloadLink?: DirectDownloadLinkDTO;

  share: ShareDTO;

  from(partial: Partial<FileDTO>) {
    return plainToClass(FileDTO, partial, { excludeExtraneousValues: true });
  }
}
