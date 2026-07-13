import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { json, NextFunction, Request, Response } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AppModule } from "./app.module";
import { loadAppConfig } from "./config/app-config";
import { migrate } from "./database/migrate";

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  if (config.autoMigrate) await migrate();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.setGlobalPrefix("api");
  app.use(json({ limit: "256kb" }));
  app.enableCors({
    origin(origin, callback) {
      callback(
        null,
        !origin || config.allowedOrigins.includes(new URL(origin).origin),
      );
    },
    credentials: true,
    allowedHeaders: ["content-type", "x-location-todo-session", "x-csrf-token"],
  });
  const publicDir = join(__dirname, "public");
  if (existsSync(publicDir)) {
    app.useStaticAssets(publicDir, { index: false });
    app.use((request: Request, response: Response, next: NextFunction) => {
      if (
        request.method !== "GET" ||
        request.path === "/api" ||
        request.path.startsWith("/api/") ||
        !request.accepts("html")
      ) {
        next();
        return;
      }
      response.sendFile(join(publicDir, "index.html"));
    });
  }
  await app.listen(config.port, config.host);
}

bootstrap().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
