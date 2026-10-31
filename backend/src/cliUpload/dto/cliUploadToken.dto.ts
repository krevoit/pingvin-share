import { Expose, plainToClass } from "class-transformer";
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateCliUploadTokenDTO {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  /** How long the token itself stays valid, e.g. "15-minutes", "1-day" */
  @IsString()
  @MaxLength(20)
  expiration: string;

  /** How many uploads the token allows. 0 = unlimited until it expires. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxUses?: number;

  /** Expiration of each share created with this token, e.g. "7-days" or "never" */
  @IsString()
  @MaxLength(20)
  shareExpiration: string;
}

export class CliUploadTokenDTO {
  @Expose()
  id: string;

  @Expose()
  name: string | null;

  @Expose()
  createdAt: Date;

  @Expose()
  expiresAt: Date;

  @Expose()
  maxUses: number | null;

  @Expose()
  useCount: number;

  @Expose()
  shareExpiration: string;

  @Expose()
  lastUsedAt: Date | null;

  @Expose()
  lastUsedIp: string | null;

  from(partial: Partial<CliUploadTokenDTO>) {
    return plainToClass(CliUploadTokenDTO, partial, {
      excludeExtraneousValues: true,
    });
  }

  fromList(partial: Partial<CliUploadTokenDTO>[]) {
    return partial.map((part) => this.from(part));
  }
}
