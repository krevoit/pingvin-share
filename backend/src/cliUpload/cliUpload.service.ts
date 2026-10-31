import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { User } from "@prisma/client";
import * as crypto from "crypto";
import { createWriteStream } from "fs";
import * as fs from "fs/promises";
import * as moment from "moment";
import { I18nService } from "nestjs-i18n";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import { ConfigService } from "src/config/config.service";
import { DATA_DIRECTORY } from "src/constants";
import { DirectLinkService } from "src/file/directLink.service";
import { CreateDirectLinkDTO } from "src/file/dto/directLink.dto";
import { FileService } from "src/file/file.service";
import { FileImportService } from "src/file/fileImport.service";
import { PrismaService } from "src/prisma/prisma.service";
import { CreateShareDTO } from "src/share/dto/createShare.dto";
import { ShareService } from "src/share/share.service";
import {
  exceedsMaxExpiration,
  parseRelativeExpiration,
} from "src/utils/expiration.util";
import { byteToHumanSizeString } from "src/utils/fileSize.util";
import { getUserActiveStorageUsage } from "src/utils/storageQuota.util";
import {
  generateSecretToken,
  hashSecretToken,
  sanitizeFileName,
} from "src/utils/token.util";
import {
  CliUploadTokenDTO,
  CreateCliUploadTokenDTO,
} from "./dto/cliUploadToken.dto";

export const CLI_TOKEN_PREFIX = "pvu_";
const CLI_TOKEN_REGEX = /^pvu_[a-zA-Z0-9_-]{32,64}$/;
const MAX_TOKEN_LIFETIME_DAYS = 365;
const MAX_ACTIVE_TOKENS_PER_USER = 50;
export const MAX_FILES_PER_UPLOAD = 100;
const TEMP_DIRECTORY = `${DATA_DIRECTORY}/uploads/_temp`;
const SHARE_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export interface CliUploadOptions {
  name?: string;
  description?: string;
  directLink?: CreateDirectLinkDTO;
}

export interface CliUploadResult {
  shareId: string;
  url: string;
  expiration: Date;
  files: {
    id: string;
    name: string;
    size: number;
    directLink?: { url: string; expiresAt: Date | null; maxDownloads: number };
  }[];
}

/**
 * One in-flight upload: owns the share being built and enforces the size
 * limits while files stream in.
 */
export class CliUploadSession {
  readonly files: { id: string; name: string; size: number }[] = [];
  private readonly usedNames = new Set<string>();
  private totalBytes = 0;

  constructor(
    private readonly service: CliUploadService,
    readonly shareId: string,
    readonly storageProvider: string,
    private readonly maxBytes: number,
    private readonly limitMessage: (exceededBytes: number) => string,
  ) {}

  async addFile(rawName: string | undefined, stream: Readable) {
    if (this.files.length >= MAX_FILES_PER_UPLOAD) {
      stream.resume();
      throw new BadRequestException(
        `At most ${MAX_FILES_PER_UPLOAD} files can be uploaded at once`,
      );
    }

    const name = this.uniqueName(sanitizeFileName(rawName));
    const id = crypto.randomUUID();
    const tempPath = `${TEMP_DIRECTORY}/cli-${id}`;

    let size = 0;
    const remaining = this.maxBytes - this.totalBytes;
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        if (size > remaining) {
          callback(
            new HttpException(
              this.limitMessage(size - remaining),
              HttpStatus.PAYLOAD_TOO_LARGE,
            ),
          );
        } else {
          callback(null, chunk);
        }
      },
    });

    try {
      await pipeline(
        stream,
        limiter,
        createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
      );
      await this.service.importFile(this, { id, name }, tempPath, size);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
    }

    this.totalBytes += size;
    this.files.push({ id, name, size });
  }

  private uniqueName(name: string) {
    let candidate = name;
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let i = 2; this.usedNames.has(candidate.toLowerCase()); i++) {
      candidate = `${base} (${i})${ext}`;
    }
    this.usedNames.add(candidate.toLowerCase());
    return candidate;
  }
}

@Injectable()
export class CliUploadService {
  private readonly logger = new Logger(CliUploadService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private shareService: ShareService,
    private fileService: FileService,
    private fileImportService: FileImportService,
    private directLinkService: DirectLinkService,
    private readonly i18n: I18nService,
  ) {}

  // ---------------------------------------------------------------------------
  // Token management (authenticated user)
  // ---------------------------------------------------------------------------

  async createToken(user: User | undefined, dto: CreateCliUploadTokenDTO) {
    if (!user) throw new UnauthorizedException();
    if (user.allowShare === false) {
      throw new ForbiddenException(this.i18n.t("share.notAllowedToShare"));
    }

    let expiresAt: Date | null;
    let shareExpiration: Date | null;
    try {
      expiresAt = parseRelativeExpiration(dto.expiration);
      shareExpiration = parseRelativeExpiration(dto.shareExpiration);
    } catch {
      throw new BadRequestException(this.i18n.t("share.invalidExpiration"));
    }

    if (
      expiresAt === null ||
      expiresAt > moment().add(MAX_TOKEN_LIFETIME_DAYS, "days").toDate()
    ) {
      throw new BadRequestException(
        `Upload tokens must expire within ${MAX_TOKEN_LIFETIME_DAYS} days`,
      );
    }

    if (
      !user.isAdmin &&
      exceedsMaxExpiration(
        shareExpiration,
        this.config.get("share.maxExpiration"),
      )
    ) {
      throw new BadRequestException(this.i18n.t("share.maxExpirationExceeded"));
    }

    const activeTokens = await this.prisma.cliUploadToken.count({
      where: { creatorId: user.id, expiresAt: { gt: new Date() } },
    });
    if (activeTokens >= MAX_ACTIVE_TOKENS_PER_USER) {
      throw new BadRequestException(
        `You can have at most ${MAX_ACTIVE_TOKENS_PER_USER} active upload tokens. Revoke some first.`,
      );
    }

    const token = generateSecretToken(32, CLI_TOKEN_PREFIX);
    const maxUses = dto.maxUses === undefined ? 1 : dto.maxUses;

    const record = await this.prisma.cliUploadToken.create({
      data: {
        name: dto.name?.trim() || null,
        tokenHash: hashSecretToken(token),
        expiresAt,
        maxUses: maxUses === 0 ? null : maxUses,
        shareExpiration: dto.shareExpiration,
        creator: { connect: { id: user.id } },
      },
    });

    return { ...new CliUploadTokenDTO().from(record), token };
  }

  async listTokens(user: User | undefined) {
    if (!user) throw new UnauthorizedException();
    const tokens = await this.prisma.cliUploadToken.findMany({
      where: { creatorId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return new CliUploadTokenDTO().fromList(tokens);
  }

  async deleteToken(user: User | undefined, id: string) {
    if (!user) throw new UnauthorizedException();
    const { count } = await this.prisma.cliUploadToken.deleteMany({
      where: { id, creatorId: user.id },
    });
    if (count === 0) throw new NotFoundException("Upload token not found");
  }

  // ---------------------------------------------------------------------------
  // Upload (token holder, no session)
  // ---------------------------------------------------------------------------

  async upload(params: {
    token: string;
    ip?: string;
    declaredSize?: number;
    options: CliUploadOptions;
    receive: (session: CliUploadSession) => Promise<void>;
  }): Promise<CliUploadResult> {
    const tokenRecord = await this.reserveTokenUse(params.token, params.ip);
    let session: CliUploadSession | undefined;

    try {
      const user = tokenRecord.creator;
      if (!user.isActivated || user.allowShare === false) {
        throw new ForbiddenException(this.i18n.t("share.notAllowedToShare"));
      }

      session = await this.startSession(
        user,
        tokenRecord.shareExpiration,
        params.options,
        params.declaredSize,
      );

      await params.receive(session);

      if (session.files.length === 0) {
        throw new BadRequestException(
          this.i18n.t("share.completionRequiresFile"),
        );
      }

      const share = await this.shareService.complete(session.shareId);

      const files: CliUploadResult["files"] = [];
      for (const file of session.files) {
        if (params.options.directLink) {
          const link = await this.directLinkService.createForFile(
            file.id,
            file.name,
            params.options.directLink,
          );
          files.push({
            ...file,
            directLink: {
              url: `${this.appUrl()}${link.path}`,
              expiresAt: link.expiresAt,
              maxDownloads: link.maxDownloads,
            },
          });
        } else {
          files.push(file);
        }
      }

      this.logger.log(
        `CLI upload by ${user.username}: share ${session.shareId} (${files.length} file(s))`,
      );

      return {
        shareId: session.shareId,
        url: `${this.appUrl()}/s/${session.shareId}`,
        expiration: share.expiration,
        files,
      };
    } catch (e) {
      if (session) await this.discardShare(session.shareId);
      await this.prisma.cliUploadToken.updateMany({
        where: { id: tokenRecord.id, useCount: { gt: 0 } },
        data: { useCount: { decrement: 1 } },
      });
      throw e;
    }
  }

  /** Called by CliUploadSession once a file has been fully written to disk. */
  async importFile(
    session: CliUploadSession,
    file: { id: string; name: string },
    tempPath: string,
    size: number,
  ) {
    await this.fileImportService.importFile(
      session.shareId,
      session.storageProvider,
      file,
      tempPath,
      size,
    );
  }

  /**
   * Atomically takes one use from the token. Every failure looks the same so
   * the endpoint can't be used to probe tokens.
   */
  private async reserveTokenUse(token: string, ip?: string) {
    const invalid = () =>
      new UnauthorizedException("Invalid, expired or used up upload token");

    if (!CLI_TOKEN_REGEX.test(token ?? "")) throw invalid();
    const tokenHash = hashSecretToken(token);
    const now = new Date();

    const { count } = await this.prisma.cliUploadToken.updateMany({
      where: {
        tokenHash,
        expiresAt: { gt: now },
        OR: [
          { maxUses: null },
          {
            useCount: { lt: this.prisma.cliUploadToken.fields.maxUses },
          },
        ],
      },
      data: {
        useCount: { increment: 1 },
        lastUsedAt: now,
        lastUsedIp: ip?.slice(0, 64) ?? null,
      },
    });
    if (count === 0) throw invalid();

    const record = await this.prisma.cliUploadToken.findUnique({
      where: { tokenHash },
      include: { creator: true },
    });
    if (!record) throw invalid();
    return record;
  }

  private async startSession(
    user: User,
    shareExpiration: string,
    options: CliUploadOptions,
    declaredSize?: number,
  ) {
    const maxShareSize = parseInt(
      user.shareSizeLimit ?? this.config.get("share.maxSize"),
    );
    let maxBytes = maxShareSize;
    let limitMessage = (_exceeded: number) =>
      this.i18n.t("file.maxSizeExceeded");

    if (user.storageQuotaLimit) {
      const quotaLeft =
        parseInt(user.storageQuotaLimit) -
        (await getUserActiveStorageUsage(this.prisma, user.id));
      if (quotaLeft < maxBytes) {
        maxBytes = Math.max(0, quotaLeft);
        limitMessage = (exceeded: number) =>
          this.i18n.t("file.storageQuotaExceeded", {
            args: { exceededSize: byteToHumanSizeString(exceeded) },
          });
      }
    }

    // The upload is buffered in the data directory before it is moved to its
    // final location, so never accept more than the disk can hold.
    const disk = await fs.statfs(TEMP_DIRECTORY);
    const freeBytes = disk.bavail * disk.bsize;
    if (freeBytes < maxBytes) {
      maxBytes = freeBytes;
      limitMessage = () => this.i18n.t("file.notEnoughSpace");
    }

    if (declaredSize !== undefined && declaredSize > maxBytes) {
      throw new HttpException(
        limitMessage(declaredSize - maxBytes),
        HttpStatus.PAYLOAD_TOO_LARGE,
      );
    }

    const shareDto = {
      id: await this.generateShareId(),
      name: options.name,
      description: options.description,
      expiration: shareExpiration,
      recipients: [],
      security: undefined,
      size: declaredSize,
    } as CreateShareDTO;

    const share = await this.shareService.create(shareDto, user);

    return new CliUploadSession(
      this,
      share.id,
      share.storageProvider,
      maxBytes,
      limitMessage,
    );
  }

  private async discardShare(shareId: string) {
    try {
      await this.fileService.deleteAllFiles(shareId);
    } catch (e) {
      this.logger.error(
        `Failed to delete files of aborted share ${shareId}`,
        e,
      );
    }
    await this.prisma.share
      .delete({ where: { id: shareId } })
      .catch(() => undefined);
  }

  private async generateShareId() {
    const length = Math.min(
      Math.max(parseInt(this.config.get("share.shareIdLength")) || 8, 8),
      50,
    );
    for (;;) {
      let id = "";
      for (let i = 0; i < length; i++) {
        id += SHARE_ID_ALPHABET[crypto.randomInt(SHARE_ID_ALPHABET.length)];
      }
      if ((await this.shareService.isShareIdAvailable(id)).isAvailable) {
        return id;
      }
    }
  }

  appUrl() {
    return `${this.config.get("general.appUrl")}`.replace(/\/+$/, "");
  }
}
