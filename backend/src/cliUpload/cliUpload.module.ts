import { Module } from "@nestjs/common";
import { FileModule } from "src/file/file.module";
import { ShareModule } from "src/share/share.module";
import { CliUploadController } from "./cliUpload.controller";
import { CliUploadService } from "./cliUpload.service";

@Module({
  imports: [ShareModule, FileModule],
  controllers: [CliUploadController],
  providers: [CliUploadService],
  exports: [CliUploadService],
})
export class CliUploadModule {}
