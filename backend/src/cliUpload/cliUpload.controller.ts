import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { User } from "@prisma/client";
import * as Busboy from "busboy";
import { Request, Response } from "express";
import { GetUser } from "src/auth/decorator/getUser.decorator";
import { JwtGuard } from "src/auth/guard/jwt.guard";
import { CreateDirectLinkDTO } from "src/file/dto/directLink.dto";
import { isValidRelativeExpiration } from "src/utils/expiration.util";
import {
  CliUploadOptions,
  CliUploadResult,
  CliUploadService,
  MAX_FILES_PER_UPLOAD,
} from "./cliUpload.service";
import { CreateCliUploadTokenDTO } from "./dto/cliUploadToken.dto";

type UploadQuery = {
  name?: string;
  description?: string;
  directLink?: string;
  linkExpiration?: string;
  maxDownloads?: string;
};

/**
 * Uploads from a terminal with a token created in the web UI.
 *
 *   curl -T ./file.iso https://host/api/cli/upload/<token>/
 *   curl -F file=@a.txt -F file=@b.txt https://host/api/cli/upload/<token>
 *
 * Optional query parameters: name, description, directLink=1,
 * linkExpiration (e.g. 1-hour), maxDownloads.
 * The response is the share URL as plain text, or JSON when the client sends
 * `Accept: application/json`.
 */
@Controller("cli")
export class CliUploadController {
  constructor(private cliUploadService: CliUploadService) {}

  @Get("tokens")
  @UseGuards(JwtGuard)
  async listTokens(@GetUser() user: User) {
    return this.cliUploadService.listTokens(user);
  }

  @Post("tokens")
  @UseGuards(JwtGuard)
  @Throttle({ default: { limit: 20, ttl: 60 * 1000 } })
  async createToken(
    @GetUser() user: User,
    @Body() body: CreateCliUploadTokenDTO,
  ) {
    return this.cliUploadService.createToken(user, body);
  }

  @Delete("tokens/:id")
  @UseGuards(JwtGuard)
  async deleteToken(@GetUser() user: User, @Param("id") id: string) {
    await this.cliUploadService.deleteToken(user, id);
  }

  @Put(["upload/:token", "upload/:token/:fileName"])
  @Throttle({ default: { limit: 30, ttl: 60 * 1000 } })
  async putUpload(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("token") token: string,
    @Param("fileName") fileName: string | undefined,
    @Query() query: UploadQuery,
  ) {
    return this.handle(req, res, token, query, (session) =>
      session.addFile(fileName, req),
    );
  }

  @Post("upload/:token")
  @Throttle({ default: { limit: 30, ttl: 60 * 1000 } })
  async multipartUpload(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("token") token: string,
    @Query() query: UploadQuery,
  ) {
    let busboy: Busboy.Busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: {
          files: MAX_FILES_PER_UPLOAD,
          fields: 10,
          fieldSize: 1024,
          parts: MAX_FILES_PER_UPLOAD + 10,
        },
      });
    } catch {
      res.setHeader("Connection", "close");
      throw new BadRequestException(
        "Send files as multipart/form-data (curl -F file=@path) or use PUT (curl -T path)",
      );
    }

    return this.handle(
      req,
      res,
      token,
      query,
      (session) =>
        new Promise<void>((resolve, reject) => {
          let chain = Promise.resolve();
          let failed = false;
          const fail = (e: unknown) => {
            if (failed) return;
            failed = true;
            req.unpipe(busboy);
            reject(e);
          };

          busboy.on("file", (_field, stream, info) => {
            chain = chain
              .then(() => {
                if (failed) {
                  stream.resume();
                  return;
                }
                return session.addFile(info.filename, stream);
              })
              .catch((e) => {
                stream.resume();
                fail(e);
              });
          });
          busboy.on("filesLimit", () =>
            fail(
              new BadRequestException(
                `At most ${MAX_FILES_PER_UPLOAD} files can be uploaded at once`,
              ),
            ),
          );
          busboy.on("partsLimit", () =>
            fail(new BadRequestException("Too many form parts")),
          );
          busboy.on("error", fail);
          busboy.on("close", () => {
            chain.then(() => {
              if (!failed) resolve();
            }, fail);
          });
          req.on("aborted", () =>
            fail(new BadRequestException("Upload aborted")),
          );

          req.pipe(busboy);
        }),
    );
  }

  private async handle(
    req: Request,
    res: Response,
    token: string,
    query: UploadQuery,
    receive: Parameters<CliUploadService["upload"]>[0]["receive"],
  ) {
    const declared = parseInt(`${req.headers["content-length"] ?? ""}`, 10);

    try {
      const result = await this.cliUploadService.upload({
        token,
        ip: req.ip,
        declaredSize:
          Number.isFinite(declared) && declared >= 0 ? declared : undefined,
        options: this.parseOptions(query),
        receive,
      });
      return this.respond(req, res, result);
    } catch (e) {
      // Don't let Node drain a (possibly huge) unread request body after an
      // error response; just drop the connection.
      res.setHeader("Connection", "close");
      throw e;
    }
  }

  private parseOptions(query: UploadQuery): CliUploadOptions {
    const options: CliUploadOptions = {};

    if (query.name !== undefined) {
      const name = `${query.name}`.trim();
      if (name.length < 3 || name.length > 30) {
        throw new BadRequestException("name must be 3-30 characters");
      }
      options.name = name;
    }

    if (query.description !== undefined) {
      const description = `${query.description}`;
      if (description.length > 512) {
        throw new BadRequestException(
          "description must be at most 512 characters",
        );
      }
      options.description = description;
    }

    if (["1", "true", "yes"].includes(`${query.directLink ?? ""}`)) {
      const link: CreateDirectLinkDTO = {};
      if (query.linkExpiration !== undefined) {
        if (!isValidRelativeExpiration(`${query.linkExpiration}`)) {
          throw new BadRequestException(
            "linkExpiration must look like 30-minutes, 1-hour, 7-days or never",
          );
        }
        link.expiration = `${query.linkExpiration}`;
      }
      if (query.maxDownloads !== undefined) {
        const max = Number(query.maxDownloads);
        if (!Number.isInteger(max) || max < 1 || max > 1000000) {
          throw new BadRequestException(
            "maxDownloads must be a positive integer",
          );
        }
        link.maxDownloads = max;
      }
      options.directLink = link;
    }

    return options;
  }

  private respond(req: Request, res: Response, result: CliUploadResult) {
    if (`${req.headers.accept ?? ""}`.includes("application/json")) {
      return result;
    }

    const lines = [result.url];
    for (const file of result.files) {
      if (file.directLink) lines.push(file.directLink.url);
    }
    res.type("text/plain");
    return lines.join("\n") + "\n";
  }
}
