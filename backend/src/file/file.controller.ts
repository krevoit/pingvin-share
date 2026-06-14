import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import * as contentDisposition from "content-disposition";
import { Response } from "express";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { CreateShareGuard } from "src/share/guard/createShare.guard";
import { StrictShareOwnerGuard } from "src/share/guard/strictShareOwner.guard";
import { IdValidation } from "src/share/guard/shareIdValidation.guard";
import { FileService } from "./file.service";
import { FileSecurityGuard } from "./guard/fileSecurity.guard";
import * as mime from "mime-types";

const VALID_ID_REGEX = /^[a-zA-Z0-9-]*={0,2}$/;
const VALID_DIRECT_DOWNLOAD_TOKEN_REGEX = /^[a-zA-Z0-9_-]+$/;

function getValidRecipientId(recipientId?: string): string | undefined {
  if (!recipientId) return undefined;
  return VALID_ID_REGEX.test(recipientId) ? recipientId : undefined;
}

@Controller("shares/:shareId/files")
export class FileController {
  constructor(private fileService: FileService) {}

  @Post()
  @SkipThrottle()
  @UseGuards(IdValidation, CreateShareGuard, StrictShareOwnerGuard)
  async create(
    @Query()
    query: {
      id: string;
      name: string;
      chunkIndex: string;
      totalChunks: string;
    },
    @Body() body: string,
    @Param("shareId") shareId: string,
  ) {
    const { id, name, chunkIndex, totalChunks } = query;

    // Data can be empty if the file is empty
    return await this.fileService.create(
      body,
      { index: parseInt(chunkIndex), total: parseInt(totalChunks) },
      { id, name },
      shareId,
    );
  }

  @Get("zip")
  @UseGuards(FileSecurityGuard)
  async getZip(
    @Res({ passthrough: true }) res: Response,
    @Param("shareId") shareId: string,
    @Query("recipient") recipientId?: string,
  ) {
    const zipStream = await this.fileService.getZip(shareId);

    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": contentDisposition(`${shareId}.zip`),
    });

    void this.fileService.notifyRecipientDownload(
      shareId,
      `${shareId}.zip`,
      getValidRecipientId(recipientId),
    );

    return new StreamableFile(zipStream);
  }

  @Get(":fileId")
  @UseGuards(FileSecurityGuard)
  async getFile(
    @Res({ passthrough: true }) res: Response,
    @Param("shareId") shareId: string,
    @Param("fileId") fileId: string,
    @Query("download") download = "true",
    @Query("recipient") recipientId?: string,
  ) {
    const file = await this.fileService.get(shareId, fileId);
    const isDownload = download === "true";

    const headers = {
      "Content-Type":
        mime?.lookup?.(file.metaData.name) || "application/octet-stream",
      "Content-Length": file.metaData.size,
      "Content-Security-Policy": "sandbox",
      "Content-Disposition": contentDisposition(
        file.metaData.name,
        isDownload ? undefined : { type: "inline" },
      ),
    };

    res.set(headers);

    if (isDownload) {
      void this.fileService.notifyRecipientDownload(
        shareId,
        file.metaData.name,
        getValidRecipientId(recipientId),
      );
    }

    return new StreamableFile(file.file);
  }

  @Post(":fileId/direct-link")
  @UseGuards(IdValidation, StrictShareOwnerGuard)
  async createDirectDownloadLink(
    @Param("shareId") shareId: string,
    @Param("fileId") fileId: string,
    @GetUser() user: User,
  ) {
    return this.fileService.createDirectDownloadLink(shareId, fileId, user);
  }

  @Delete(":fileId/direct-link")
  @UseGuards(IdValidation, StrictShareOwnerGuard)
  async revokeDirectDownloadLink(
    @Param("shareId") shareId: string,
    @Param("fileId") fileId: string,
    @GetUser() user: User,
  ) {
    await this.fileService.revokeDirectDownloadLink(shareId, fileId, user);
  }

  @Get(":fileId/direct/:token")
  async getDirectDownload(
    @Res({ passthrough: true }) res: Response,
    @Param("shareId") shareId: string,
    @Param("fileId") fileId: string,
    @Param("token") token: string,
  ) {
    if (!VALID_DIRECT_DOWNLOAD_TOKEN_REGEX.test(token)) {
      throw new BadRequestException("Invalid direct download token format");
    }

    const file = await this.fileService.getDirectDownload(
      shareId,
      fileId,
      token,
    );

    res.set({
      "Content-Type":
        mime?.lookup?.(file.metaData.name) || "application/octet-stream",
      "Content-Length": file.metaData.size,
      "Content-Security-Policy": "sandbox",
      "Content-Disposition": contentDisposition(file.metaData.name),
      "Cache-Control": "no-store",
      Pragma: "no-cache",
    });

    return new StreamableFile(file.file);
  }

  @Delete(":fileId")
  @SkipThrottle()
  @UseGuards(StrictShareOwnerGuard)
  async remove(
    @Param("fileId") fileId: string,
    @Param("shareId") shareId: string,
  ) {
    await this.fileService.remove(shareId, fileId);
  }
}
