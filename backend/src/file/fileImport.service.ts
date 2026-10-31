import { Injectable, Logger } from "@nestjs/common";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createReadStream } from "fs";
import * as fs from "fs/promises";
import { resolve, sep } from "path";
import { PrismaService } from "src/prisma/prisma.service";
import { ConfigService } from "src/config/config.service";
import { SHARE_DIRECTORY } from "../constants";
import { S3FileService } from "./s3.service";

const S3_PART_SIZE = 16 * 1024 * 1024;
const S3_MAX_PARTS = 10000;

/**
 * Moves a fully written temporary file into a share's storage (local disk or
 * S3) and registers it in the database. Used by uploads that arrive as a
 * single stream (e.g. CLI uploads) instead of the browser's chunk protocol.
 */
@Injectable()
export class FileImportService {
  private readonly logger = new Logger(FileImportService.name);

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private s3FileService: S3FileService,
  ) {}

  async importFile(
    shareId: string,
    storageProvider: string,
    file: { id: string; name: string },
    sourcePath: string,
    size: number,
  ) {
    if (storageProvider === "S3") {
      await this.importToS3(shareId, file.name, sourcePath, size);
    } else {
      await this.importToLocal(shareId, file.id, sourcePath);
    }

    await this.prisma.file.create({
      data: {
        id: file.id,
        name: file.name,
        size: size.toString(),
        share: { connect: { id: shareId } },
      },
    });
  }

  private async importToLocal(
    shareId: string,
    fileId: string,
    sourcePath: string,
  ) {
    const baseDir = resolve(SHARE_DIRECTORY, shareId);
    const destination = resolve(baseDir, fileId);
    if (!destination.startsWith(baseDir + sep)) {
      throw new Error("Invalid file path");
    }

    await fs.mkdir(baseDir, { recursive: true });
    try {
      await fs.rename(sourcePath, destination);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      await fs.copyFile(sourcePath, destination);
      await fs.unlink(sourcePath);
    }
  }

  private async importToS3(
    shareId: string,
    fileName: string,
    sourcePath: string,
    size: number,
  ) {
    const s3 = this.s3FileService.getS3Instance();
    const Bucket = this.config.get("s3.bucketName");
    const Key = `${this.s3FileService.getS3Path()}${shareId}/${fileName}`;

    if (size <= S3_PART_SIZE) {
      await s3.send(
        new PutObjectCommand({
          Bucket,
          Key,
          Body: createReadStream(sourcePath),
          ContentLength: size,
        }),
      );
      return;
    }

    const partSize = Math.max(S3_PART_SIZE, Math.ceil(size / S3_MAX_PARTS));
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({ Bucket, Key }),
    );

    try {
      const parts: { ETag: string; PartNumber: number }[] = [];
      for (let start = 0, n = 1; start < size; start += partSize, n++) {
        const end = Math.min(start + partSize, size) - 1;
        const { ETag } = await s3.send(
          new UploadPartCommand({
            Bucket,
            Key,
            UploadId,
            PartNumber: n,
            Body: createReadStream(sourcePath, { start, end }),
            ContentLength: end - start + 1,
          }),
        );
        parts.push({ ETag, PartNumber: n });
      }

      await s3.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key,
          UploadId,
          MultipartUpload: { Parts: parts },
        }),
      );
    } catch (e) {
      await s3
        .send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }))
        .catch((abortError) =>
          this.logger.error("Failed to abort S3 multipart upload", abortError),
        );
      throw e;
    }
  }
}
