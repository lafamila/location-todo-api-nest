import { Controller, Get, Res } from "@nestjs/common";
import { Response } from "express";
import { DatabaseService } from "./database/database.service";

@Controller("health")
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

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
      };
    } catch {
      response.status(503);
      return {
        status: "down",
        process: "ok",
        database: "down",
        migrations: { current: null, pending: -1 },
      };
    }
  }
}
