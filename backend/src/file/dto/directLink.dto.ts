import { Expose, plainToClass } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateDirectLinkDTO {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  /** Relative expiration like "1-hour", "30-minutes" or "never" */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  expiration?: string;

  /** Number of downloads after which the link stops working. Empty = unlimited */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000000)
  maxDownloads?: number;
}

export class DirectLinkDTO {
  @Expose()
  id: string;

  @Expose()
  name: string | null;

  @Expose()
  createdAt: Date;

  @Expose()
  expiresAt: Date | null;

  @Expose()
  maxDownloads: number | null;

  @Expose()
  downloadCount: number;

  @Expose()
  revokedAt: Date | null;

  @Expose()
  lastUsedAt: Date | null;

  @Expose()
  lastUsedIp: string | null;

  from(partial: Partial<DirectLinkDTO>) {
    return plainToClass(DirectLinkDTO, partial, {
      excludeExtraneousValues: true,
    });
  }

  fromList(partial: Partial<DirectLinkDTO>[]) {
    return partial.map((part) =>
      plainToClass(DirectLinkDTO, part, { excludeExtraneousValues: true }),
    );
  }
}
