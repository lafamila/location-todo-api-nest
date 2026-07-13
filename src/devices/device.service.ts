import { Injectable } from "@nestjs/common";
import { ServiceSession } from "../auth/auth.types";
import { ApiError, requireString, requireUuid } from "../common/errors";
import { Platform } from "../contracts/v1";
import { DatabaseService } from "../database/database.service";

interface DeviceRow {
  id: string;
  installation_id: string;
  platform: Platform;
  app_version: string;
  active: boolean;
  last_seen_at: Date;
  push_token_updated_at: Date | null;
  created_at: Date;
}

@Injectable()
export class DeviceService {
  constructor(private readonly db: DatabaseService) {}

  async list(accountId: string) {
    const result = await this.db.query<DeviceRow>(
      `select id,installation_id,platform,app_version,active,last_seen_at,push_token_updated_at,created_at
       from devices where account_id=$1 order by last_seen_at desc`,
      [accountId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      installationId: row.installation_id,
      platform: row.platform,
      appVersion: row.app_version,
      active: row.active,
      pushTokenRegistered: Boolean(row.push_token_updated_at),
      lastSeenAt: row.last_seen_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    }));
  }

  async register(
    session: ServiceSession,
    input: {
      installationId: string;
      platform: Platform;
      appVersion: string;
      pushToken?: string | null;
    },
  ) {
    if (!input || typeof input !== "object")
      throw new ApiError("VALIDATION_ERROR", "Device body is required");
    const installationId = requireString(
      input.installationId,
      "installationId",
      128,
    );
    const appVersion = requireString(input.appVersion, "appVersion", 40);
    if (
      !["ios", "android", "macos", "windows", "web"].includes(input.platform)
    ) {
      throw new ApiError("VALIDATION_ERROR", "platform is invalid");
    }
    if (!session.platform || input.platform !== session.platform) {
      throw new ApiError(
        "DEVICE_PLATFORM_MISMATCH",
        "Device platform must match the authenticated login platform",
        409,
      );
    }
    if (input.pushToken && !["ios", "android"].includes(input.platform)) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "Only mobile devices can register a push token",
      );
    }
    const pushToken = input.pushToken
      ? requireString(input.pushToken, "pushToken", 4096)
      : null;
    return this.db.transaction(async (query) => {
      if (pushToken) {
        await query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
          `location-todo-push-token:${pushToken}`,
        ]);
        await query(
          `update devices set push_token=null,push_token_updated_at=null where push_token=$1`,
          [pushToken],
        );
      }
      const result = await query<{ id: string; push_token: string | null }>(
        `insert into devices(account_id,installation_id,platform,app_version,push_token,push_token_updated_at,active,last_seen_at)
         values($1,$2,$3,$4,$5,case when $5::text is null then null else now() end,true,now())
         on conflict(account_id,installation_id) do update set app_version=excluded.app_version,
         push_token=coalesce(excluded.push_token,devices.push_token),push_token_updated_at=case when excluded.push_token is null then devices.push_token_updated_at else now() end,
         active=true,last_seen_at=now() where devices.platform=excluded.platform returning id,push_token`,
        [
          session.account.id,
          installationId,
          input.platform,
          appVersion,
          pushToken,
        ],
      );
      const deviceId = result.rows[0]?.id;
      if (!deviceId)
        throw new ApiError(
          "DEVICE_PLATFORM_IMMUTABLE",
          "An installation cannot change platform",
          409,
        );
      const bound = await query(
        `update app_sessions set device_id=$2 where id=$1 and account_id=$3 and client_platform=$4`,
        [session.id, deviceId, session.account.id, input.platform],
      );
      if (!bound.rowCount)
        throw new ApiError(
          "DEVICE_PLATFORM_MISMATCH",
          "Session platform does not match the device",
          409,
        );
      return {
        id: deviceId,
        installationId,
        platform: input.platform,
        appVersion,
        pushTokenRegistered: Boolean(result.rows[0]?.push_token),
      };
    });
  }

  async revoke(accountId: string, id: string): Promise<{ ok: true }> {
    requireUuid(id, "deviceId");
    const result = await this.db.query(
      `update devices set active=false,push_token=null,push_token_updated_at=null where id=$1 and account_id=$2`,
      [id, accountId],
    );
    if (!result.rowCount)
      throw new ApiError("DEVICE_NOT_FOUND", "Device not found", 404);
    await this.db.query("delete from app_sessions where device_id=$1", [id]);
    return { ok: true };
  }
}
