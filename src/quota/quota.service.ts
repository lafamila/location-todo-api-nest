import { Injectable } from "@nestjs/common";
import { ApiError } from "../common/errors";
import { Permission, QuotaDto } from "../contracts/v1";
import { DatabaseService, Query } from "../database/database.service";
import { AuthAccount } from "../auth/auth.types";

const LIMITS: Record<
  Permission,
  { location: number | null; geofence: number }
> = {
  visitor: { location: 3, geofence: 1 },
  user: { location: 20, geofence: 5 },
  superadmin: { location: null, geofence: 20 },
};

@Injectable()
export class QuotaService {
  constructor(private readonly db: DatabaseService) {}

  async get(
    account: AuthAccount,
    query: Query = this.db.query.bind(this.db),
  ): Promise<QuotaDto> {
    const result = await query<{
      location_count: number;
      time_count: number;
      geofence_count: number;
      upgrade_status: string | null;
    }>(
      `select
        (select count(*)::int from todos where account_id=$1 and kind='LOCATION' and deleted_at is null) location_count,
        (select count(*)::int from todos where account_id=$1 and kind='TIME' and deleted_at is null) time_count,
        (select count(*)::int from saved_geofences where account_id=$1 and deleted_at is null) geofence_count,
        (select upgrade_status from accounts where id=$1) upgrade_status`,
      [account.id],
    );
    const row = result.rows[0] ?? {
      location_count: 0,
      time_count: 0,
      geofence_count: 0,
      upgrade_status: null,
    };
    const limits = LIMITS[account.permission];
    return {
      permission: account.permission,
      locationTodos: { used: row.location_count, limit: limits.location },
      savedGeofences: { used: row.geofence_count, limit: limits.geofence },
      timeTodos: { used: row.time_count, limit: null },
      upgradeStatus:
        row.upgrade_status === "pending" ||
        row.upgrade_status === "approved" ||
        row.upgrade_status === "rejected"
          ? row.upgrade_status
          : account.permission === "visitor"
            ? "available"
            : null,
    };
  }

  async lockAccount(accountId: string, query: Query): Promise<void> {
    await query(`select pg_advisory_xact_lock(hashtext($1))`, [
      `location-todo:quota:${accountId}`,
    ]);
  }

  async assertAvailable(
    account: AuthAccount,
    resource: "locationTodo" | "savedGeofence",
    query: Query,
  ): Promise<void> {
    await this.lockAccount(account.id, query);
    const quota = await this.get(account, query);
    const current =
      resource === "locationTodo" ? quota.locationTodos : quota.savedGeofences;
    if (current.limit !== null && current.used >= current.limit) {
      throw new ApiError("QUOTA_EXCEEDED", `${resource} quota exceeded`, 409, {
        resource,
        permission: account.permission,
        used: current.used,
        limit: current.limit,
        upgradeStatus: quota.upgradeStatus,
      });
    }
  }
}
