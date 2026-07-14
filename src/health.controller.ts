import { Controller, Get, Res } from "@nestjs/common";
import { Response } from "express";
import { ConfigService } from "./config/config.service";
import { DatabaseService } from "./database/database.service";
import { FcmService } from "./notifications/fcm.service";

@Controller("health")
export class HealthController {
  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly fcm: FcmService,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) response: Response) {
    try {
      await this.db.query("select 1");
      const migrations = await this.db.migrationStatus();
      const healthy = migrations.pending === 0;
      if (!healthy) response.status(503);
      return {
        status: healthy ? "ok" : "degraded",
        process: "ok",
        database: "ok",
        migrations,
        workers: { enabled: this.config.value.workerEnabled },
        firebase: this.fcm.status(),
      };
    } catch {
      response.status(503);
      return {
        status: "down",
        process: "ok",
        database: "down",
        migrations: { current: null, pending: -1 },
        workers: { enabled: this.config.value.workerEnabled },
        firebase: this.fcm.status(),
      };
    }
  }
}
