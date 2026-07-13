import { Injectable } from "@nestjs/common";
import { ApiError, requireInteger, requireUuid } from "../common/errors";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class NotificationService {
  constructor(private readonly db: DatabaseService) {}

  async list(accountId: string, after = 0, limit = 50) {
    const safeAfter = requireInteger(
      after,
      "after",
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const safeLimit = requireInteger(limit, "limit", 1, 100);
    const result = await this.db.query<{
      cursor: string;
      payload: Record<string, unknown>;
      acknowledged_at: Date | null;
      created_at: Date;
    }>(
      `select cursor,payload,acknowledged_at,created_at from notification_inbox
       where account_id=$1 and cursor>$2 order by cursor limit $3`,
      [accountId, safeAfter, safeLimit],
    );
    return {
      notifications: result.rows.map((row) => ({
        ...row.payload,
        cursor: Number(row.cursor),
        acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: result.rows.length
        ? Number(result.rows.at(-1)!.cursor)
        : safeAfter,
    };
  }

  async acknowledge(accountId: string, eventIds: string[]) {
    if (
      !Array.isArray(eventIds) ||
      eventIds.length < 1 ||
      eventIds.length > 100
    )
      throw new ApiError(
        "VALIDATION_ERROR",
        "eventIds must contain 1..100 entries",
      );
    eventIds.forEach((id) => requireUuid(id, "eventId"));
    const result = await this.db.query(
      `update notification_inbox set acknowledged_at=coalesce(acknowledged_at,now())
       where account_id=$1 and trigger_event_id=any($2::uuid[])`,
      [accountId, eventIds],
    );
    return { acknowledged: result.rowCount };
  }
}
