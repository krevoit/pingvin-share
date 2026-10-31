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
export const CLI_TEMP_DIRECTORY = `${DATA_DIRECTORY}/uploads/_temp`;
const TEMP_DIRECTORY = CLI_TEMP_DIRECTORY;
const DISK_SAFETY_MARGIN = 512 * 1024 * 1024;
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

  constructor(
    private readonly service: CliUploadService,
    readonly shareId: string,
    readonly storageProvider: string,
    /** Accounts for `bytes` more being written; throws when a limit is hit */
    private readonly reserve: (bytes: number) => void,
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
    const limiter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        size += chunk.length;
        try {
          this.reserve(chunk.length);
          callback(null, chunk);
        } catch (e) {
          callback(e as Error);
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

  // Bytes written by uploads that are still in progress. Needed because the
  // database only knows about a file once it has been fully written, so
  // concurrent uploads would otherwise each see the full quota / free disk.
  private readonly inFlightBytesByUser = new Map<string, number>();
  private inFlightBytesTotal = 0;

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
    let releaseBytes = () => undefined as void;

    try {
      const user = tokenRecord.creator;
      if (!user.isActivated || user.allowShare === false) {
        throw new ForbiddenException(this.i18n.t("share.notAllowedToShare"));
      }

      const started = await this.startSession(
        user,
        tokenRecord.shareExpiration,
        params.options,
        params.declaredSize,
      );
      session = started.session;
      releaseBytes = started.release;

      await params.receive(session);

      if (session.files.length === 0) {
        throw new BadRequestException(
          this.i18n.t("share.completionRequiresFile"),
        );
      }

      // Authoritative re-check now that this upload's files are in the DB
      if (
        user.storageQuotaLimit &&
        (await getUserActiveStorageUsage(this.prisma, user.id)) >
          parseInt(user.storageQuotaLimit)
      ) {
        throw this.tooLarge();
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
    } finally {
      releaseBytes();
    }
  }

  private tooLarge() {
    // Deliberately generic: token holders shouldn't learn the owner's
    // remaining quota or the server's free disk space.
    return new HttpException(
      "Upload exceeds the allowed size",
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
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
    // Keep the share from being reaped as "unfinished" during long uploads
    await this.prisma.share.update({
      where: { id: session.shareId },
      data: { updatedAt: new Date() },
    });
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
    const quotaLimit = user.storageQuotaLimit
      ? parseInt(user.storageQuotaLimit)
      : null;
    const usageAtStart =
      quotaLimit !== null
        ? await getUserActiveStorageUsage(this.prisma, user.id)
        : 0;

    // Uploads are buffered in the data directory before being moved to their
    // final location, so leave a safety margin for the database and others.
    const disk = await fs.statfs(TEMP_DIRECTORY);
    const freeAtStart = disk.bavail * disk.bsize;
    const totalAtStart = this.inFlightBytesTotal;

    const fits = (sessionBytes: number) =>
      sessionBytes <= maxShareSize &&
      (quotaLimit === null ||
        usageAtStart + (this.inFlightBytesByUser.get(user.id) ?? 0) <=
          quotaLimit) &&
      freeAtStart - (this.inFlightBytesTotal - totalAtStart) >=
        DISK_SAFETY_MARGIN;

    if (
      declaredSize !== undefined &&
      (declaredSize > maxShareSize ||
        (quotaLimit !== null &&
          usageAtStart +
            (this.inFlightBytesByUser.get(user.id) ?? 0) +
            declaredSize >
            quotaLimit) ||
        freeAtStart - declaredSize < DISK_SAFETY_MARGIN)
    ) {
      throw this.tooLarge();
    }
    if (!fits(0)) throw this.tooLarge();

    let sessionBytes = 0;
    const reserve = (bytes: number) => {
      sessionBytes += bytes;
      this.inFlightBytesTotal += bytes;
      this.inFlightBytesByUser.set(
        user.id,
        (this.inFlightBytesByUser.get(user.id) ?? 0) + bytes,
      );
      if (!fits(sessionBytes)) throw this.tooLarge();
    };
    const release = () => {
      this.inFlightBytesTotal -= sessionBytes;
      const left = (this.inFlightBytesByUser.get(user.id) ?? 0) - sessionBytes;
      if (left > 0) this.inFlightBytesByUser.set(user.id, left);
      else this.inFlightBytesByUser.delete(user.id);
      sessionBytes = 0;
    };

    const shareDto = {
      id: await this.generateShareId(),
      name: options.name,
      description: options.description,
      expiration: shareExpiration,
      recipients: [],
      security: undefined,
      size: declaredSize,
    } as CreateShareDTO;

    let share: Awaited<ReturnType<ShareService["create"]>>;
    try {
      share = await this.shareService.create(shareDto, user);
    } catch (e) {
      release();
      throw e;
    }

    return {
      session: new CliUploadSession(
        this,
        share.id,
        share.storageProvider,
        reserve,
      ),
      release,
    };
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
