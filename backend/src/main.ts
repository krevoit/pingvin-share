import { ClassSerializerInterceptor, Logger, LogLevel } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as bodyParser from "body-parser";
import * as cookieParser from "cookie-parser";
import * as express from "express";
import { NextFunction, Request, Response } from "express";
import * as fs from "fs";
import { I18nValidationExceptionFilter, I18nValidationPipe } from "nestjs-i18n";
import { AppModule } from "./app.module";
import { ConfigService } from "./config/config.service";
import {
  DATA_DIRECTORY,
  LOG_LEVEL_AVAILABLE,
  LOG_LEVEL_DEFAULT,
  LOG_LEVEL_ENV,
} from "./constants";

function generateNestJsLogLevels(): LogLevel[] {
  if (LOG_LEVEL_ENV) {
    const levelIndex = LOG_LEVEL_AVAILABLE.indexOf(LOG_LEVEL_ENV as any);
    if (levelIndex === -1) {
      throw new Error(`log level ${LOG_LEVEL_ENV} unknown`);
    }

    return LOG_LEVEL_AVAILABLE.slice(levelIndex, LOG_LEVEL_AVAILABLE.length);
  } else {
    const levelIndex = LOG_LEVEL_AVAILABLE.indexOf(LOG_LEVEL_DEFAULT);
    return LOG_LEVEL_AVAILABLE.slice(levelIndex, LOG_LEVEL_AVAILABLE.length);
  }
}

async function bootstrap() {
  const logLevels = generateNestJsLogLevels();
  Logger.log(`Showing ${logLevels.join(", ")} messages`);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: logLevels,
    // Body parsers are registered manually below, after the middleware that
    // lets streamed CLI uploads bypass them.
    bodyParser: false,
  });

  app.useGlobalPipes(new I18nValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new I18nValidationExceptionFilter());
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const config = app.get<ConfigService>(ConfigService);

  // CLI uploads stream the request body straight to disk, so no body parser
  // may consume it.
  const isStreamedUpload = (req: Request) =>
    req.path.toLowerCase().startsWith("/api/cli/upload/");
  const jsonParser = express.json();
  const urlencodedParser = express.urlencoded({ extended: true });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isStreamedUpload(req)) return next();

    const chunkSize = config.get("share.chunkSize");
    bodyParser.raw({
      type: "application/octet-stream",
      limit: `${chunkSize}B`,
    })(req, res, next);
  });
  app.use((req: Request, res: Response, next: NextFunction) =>
    isStreamedUpload(req) ? next() : jsonParser(req, res, next),
  );
  app.use((req: Request, res: Response, next: NextFunction) =>
    isStreamedUpload(req) ? next() : urlencodedParser(req, res, next),
  );

  app.use(cookieParser());
  app.set("trust proxy", process.env.TRUST_PROXY === "true");

  await fs.promises.mkdir(`${DATA_DIRECTORY}/uploads/_temp`, {
    recursive: true,
  });

  app.setGlobalPrefix("api");

  // Setup Swagger in development mode
  if (process.env.NODE_ENV == "development") {
    const config = new DocumentBuilder()
      .setTitle("Pingvin Share API")
      .setVersion("1.0")
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("api/swagger", app, document);
  }

  const server = await app.listen(
    parseInt(process.env.BACKEND_PORT || process.env.PORT || "8080"),
  );

  // Node's default 5 minute limit for receiving a whole request would cut off
  // large streamed CLI uploads. Instead, drop connections that go idle.
  server.requestTimeout = 0;
  server.setTimeout(10 * 60 * 1000);

  const logger = new Logger("UnhandledAsyncError");
  process.on("unhandledRejection", (e) => logger.error(e));
}
bootstrap();
