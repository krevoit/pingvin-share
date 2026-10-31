import { Controller, Get, Param, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { DirectLinkService } from "./directLink.service";

/**
 * Public, unauthenticated download endpoint for direct download links.
 *
 *   GET /api/dl/:token
 *   GET /api/dl/:token/:fileName   (the file name is cosmetic, so plain
 *                                   `wget` / `curl -O` pick a sensible name)
 *
 * Every GET that returns file content consumes one download from the link,
 * including range requests. HEAD requests never consume a download.
 */
@Controller("dl")
export class DirectDownloadController {
  constructor(private directLinkService: DirectLinkService) {}

  @Get([":token", ":token/:fileName"])
  async download(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Param("token") token: string,
  ) {
    return this.directLinkService.serveDownload(req, res, token);
  }
}
