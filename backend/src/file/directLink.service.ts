import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  Injectable,
  NotFoundException,
  StreamableFile,
} from "@nestjs/common";
import { User } from "@prisma/client";
import * as contentDisposition from "content-disposition";
import { Request, Response } from "express";
import * as mime from "mime-types";
import * as rangeParser from "range-parser";
import * as moment from "moment";
import { I18nService } from "nestjs-i18n";
import { PrismaService } from "src/prisma/prisma.service";
import { parseRelativeExpiration } from "src/utils/expiration.util";
import { generateSecretToken, hashSecretToken } from "src/utils/token.util";
import { CreateDirectLinkDTO, DirectLinkDTO } from "./dto/directLink.dto";
import { FileService } from "./file.service";

export const DIRECT_LINK_TOKEN_REGEX = /^[a-zA-Z0-9_-]{16,128}$/;
const MAX_ACTIVE_LINKS_PER_FILE = 50;
const DEFAULT_EXPIRATION = "1-hour";

export type UsableDirectLink = Awaited<
  ReturnType<DirectLinkService["findUsable"]>
>;

@Injectable()
export class DirectLinkService {
  constructor(
    private prisma: PrismaService,
    private fileService: FileService,
    private readonly i18n: I18nService,
  ) {}

  static buildPath(token: string, fileName: string) {
    return `/api/dl/${token}/${encodeURIComponent(fileName)}`;
  }

  async list(shareId: string, fileId: string, user?: User) {
    const file = await this.getManagedFile(shareId, fileId, user);
    const links = await this.prisma.directDownloadLink.findMany({
      where: { fileId: file.id },
      orderBy: { createdAt: "desc" },
    });
    return new DirectLinkDTO().fromList(links);
  }

  async create(
    shareId: string,
    fileId: string,
    user: User | undefined,
    dto: CreateDirectLinkDTO,
  ) {
    const file = await this.getManagedFile(shareId, fileId, user);
    if (user.allowShare === false) {
      throw new ForbiddenException(this.i18n.t("share.notAllowedToShare"));
    }
    if (!file.share.uploadLocked) {
      throw new BadRequestException(this.i18n.t("share.notFound"));
    }
    return this.createForFile(file.id, file.name, dto);
  }

  /**
   * Creates a link without any ownership checks. Callers must have verified
   * that the requester is allowed to create links for this file.
   */
  async createForFile(
    fileId: string,
    fileName: string,
    dto: CreateDirectLinkDTO,
  ) {
    let expiresAt: Date | null;
    try {
      expiresAt = parseRelativeExpiration(dto.expiration ?? DEFAULT_EXPIRATION);
    } catch {
      throw new BadRequestException(this.i18n.t("share.invalidExpiration"));
    }

    const activeLinks = await this.prisma.directDownloadLink.count({
      where: {
        fileId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    if (activeLinks >= MAX_ACTIVE_LINKS_PER_FILE) {
      throw new BadRequestException(
        `A file can have at most ${MAX_ACTIVE_LINKS_PER_FILE} active direct links. Revoke some first.`,
      );
    }

    const token = generateSecretToken(24);
    const link = await this.prisma.directDownloadLink.create({
      data: {
        name: dto.name?.trim() || null,
        tokenHash: hashSecretToken(token),
        expiresAt,
        maxDownloads: dto.maxDownloads ?? null,
        file: { connect: { id: fileId } },
      },
    });

    return {
      ...new DirectLinkDTO().from(link),
      token,
      path: DirectLinkService.buildPath(token, fileName),
    };
  }

  async revoke(shareId: string, fileId: string, linkId: string, user?: User) {
    const file = await this.getManagedFile(shareId, fileId, user);
    const { count } = await this.prisma.directDownloadLink.updateMany({
      where: { id: linkId, fileId: file.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.prisma.directDownloadLink.count({
        where: { id: linkId, fileId: file.id },
      });
      if (!exists) throw new NotFoundException("Direct link not found");
    }
  }

  async revokeAll(shareId: string, fileId: string, user?: User) {
    const file = await this.getManagedFile(shareId, fileId, user);
    const { count } = await this.prisma.directDownloadLink.updateMany({
      where: { fileId: file.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: count };
  }

  /**
   * Resolves a token to a link that may currently be used. Every failure mode
   * returns the same generic 404 so a token holder can't learn anything about
   * the share behind it.
   */
  async findUsable(token: string) {
    const notFound = () =>
      new NotFoundException(
        "This download link is invalid, expired, revoked or has reached its download limit.",
      );

    if (!DIRECT_LINK_TOKEN_REGEX.test(token)) throw notFound();

    const link = await this.prisma.directDownloadLink.findUnique({
      where: { tokenHash: hashSecretToken(token) },
      include: {
        file: { include: { share: { include: { security: true } } } },
      },
    });

    if (!link) throw notFound();

    const share = link.file.share;
    const now = moment();
    const shareExpired =
      !moment(share.expiration).isSame(0) && now.isAfter(share.expiration);

    if (
      link.revokedAt ||
      (link.expiresAt && now.isSameOrAfter(link.expiresAt)) ||
      (link.maxDownloads !== null && link.downloadCount >= link.maxDownloads) ||
      !share.uploadLocked ||
      share.removedReason ||
      shareExpired ||
      (share.security?.maxViews && share.views >= share.security.maxViews)
    ) {
      throw notFound();
    }

    return link;
  }

  /**
   * Atomically consumes one download from the link (and one view from the
   * share, honouring its max views setting). Throws if the link was used up
   * or revoked in the meantime.
   */
  async recordDownload(link: UsableDirectLink, ip?: string) {
    const now = new Date();
    const { count } = await this.prisma.directDownloadLink.updateMany({
      where: {
        id: link.id,
        revokedAt: null,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            OR: [
              { maxDownloads: null },
              {
                downloadCount: {
                  lt: this.prisma.directDownloadLink.fields.maxDownloads,
                },
              },
            ],
          },
        ],
      },
      data: {
        downloadCount: { increment: 1 },
        lastUsedAt: now,
        lastUsedIp: ip?.slice(0, 64) ?? null,
      },
    });

    if (count === 0) {
      throw new NotFoundException(
        "This download link is invalid, expired, revoked or has reached its download limit.",
      );
    }

    const maxViews = link.file.share.security?.maxViews;
    const { count: viewCount } = await this.prisma.share.updateMany({
      where: {
        id: link.file.shareId,
        ...(maxViews ? { views: { lt: maxViews } } : {}),
      },
      data: { views: { increment: 1 } },
    });

    if (viewCount === 0) {
      await this.prisma.directDownloadLink.updateMany({
        where: { id: link.id, downloadCount: { gt: 0 } },
        data: { downloadCount: { decrement: 1 } },
      });
      throw new ForbiddenException(
        this.i18n.t("share.maxViewsExceeded"),
        "share_max_views_exceeded",
      );
    }
  }

  async deleteStale() {
    const cutoff = moment().subtract(7, "days").toDate();
    const { count } = await this.prisma.directDownloadLink.deleteMany({
      where: {
        OR: [
          { revokedAt: { lt: cutoff } },
          { expiresAt: { lt: cutoff } },
          {
            AND: [
              { maxDownloads: { not: null } },
              {
                downloadCount: {
                  gte: this.prisma.directDownloadLink.fields.maxDownloads,
                },
              },
              { lastUsedAt: { lt: cutoff } },
            ],
          },
        ],
      },
    });
    return count;
  }

  /**
   * Returns the file if `user` owns the share it belongs to (directly or via
   * a reverse share they created). Admins are deliberately not included:
   * minting download links for other people's files is not an admin task.
   */
  private async getManagedFile(shareId: string, fileId: string, user?: User) {
    const file = await this.prisma.file.findFirst({
      where: { id: fileId, shareId },
      include: { share: { include: { reverseShare: true } } },
    });

    if (!file) throw new NotFoundException(this.i18n.t("file.notFound"));

    const isOwner =
      !!user &&
      (file.share.creatorId === user.id ||
        file.share.reverseShare?.creatorId === user.id);

    if (!isOwner) throw new ForbiddenException();

    return file;
  }

  /**
   * Streams the file behind a direct link. Every GET that returns content
   * consumes one download (range requests included); HEAD never does.
   * `expected` pins the token to a specific share/file (legacy URL format).
   */
  async serveDownload(
    req: Request,
    res: Response,
    token: string,
    expected?: { shareId: string; fileId: string },
  ) {
    res.set({
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
    });

    const link = await this.findUsable(token);
    const file = link.file;

    if (
      expected &&
      (file.id !== expected.fileId || file.shareId !== expected.shareId)
    ) {
      throw new NotFoundException();
    }

    const totalSize = parseInt(file.size, 10);
    let range: { start: number; end: number } | undefined;

    const rangeHeader = req.headers.range;
    if (rangeHeader && totalSize > 0) {
      const parsed = rangeParser(totalSize, rangeHeader, { combine: true });
      if (parsed === -1) {
        res.status(HttpStatus.REQUESTED_RANGE_NOT_SATISFIABLE);
        res.set({
          "Content-Range": `bytes */${totalSize}`,
          "Accept-Ranges": "bytes",
        });
        return;
      }
      if (Array.isArray(parsed) && parsed.type === "bytes" && parsed.length) {
        range = { start: parsed[0].start, end: parsed[0].end };
      }
    }

    const headers: Record<string, string | number> = {
      "Content-Type": mime.lookup(file.name) || "application/octet-stream",
      "Content-Disposition": contentDisposition(file.name),
      "Content-Security-Policy": "sandbox",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
      "Content-Length": range ? range.end - range.start + 1 : totalSize,
    };
    if (range) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      headers["Content-Range"] =
        `bytes ${range.start}-${range.end}/${totalSize}`;
    }

    if (req.method === "HEAD") {
      res.set(headers);
      return;
    }

    await this.recordDownload(link, req.ip);

    const stored = await this.fileService.get(file.shareId, file.id, range);
    res.set(headers);
    return new StreamableFile(stored.file);
  }
}
