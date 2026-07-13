import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "../config/config.service";
import { DatabaseService } from "../database/database.service";

@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
  ) {}

  onModuleInit(): void {
    if (!this.config.value.workerEnabled) return;
    this.timer = setInterval(
      () => void this.run().catch(() => undefined),
      this.config.value.retentionIntervalMs,
    );
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<{
    devices: number;
    transitions: number;
    notifications: number;
    triggers: number;
  }> {
    return this.db
      .transaction(async (query) => {
        await query(
          `delete from login_transactions where expires_at<now()-interval '1 day'`,
        );
        await query(
          `delete from map_handoffs where expires_at<now()-interval '1 day'`,
        );
        await query(
          `delete from rate_limit_counters where window_start<now()-interval '2 days'`,
        );
        await query(
          `delete from app_sessions where revoked_at is not null or idle_expires_at<now() or absolute_expires_at<now()`,
        );
        const attempts = await query(
          `delete from delivery_attempts where created_at<now()-interval '30 days'`,
        );
        const outbox = await query(
          `delete from notification_outbox where created_at<now()-interval '30 days'`,
        );
        const inbox = await query(
          `delete from notification_inbox where created_at<now()-interval '30 days'`,
        );
        const triggers = await query(
          `delete from trigger_events where triggered_at<now()-interval '30 days'
         and not exists(select 1 from notification_inbox i where i.trigger_event_id=trigger_events.id)
         and not exists(select 1 from notification_outbox o where o.trigger_event_id=trigger_events.id)`,
        );
        const transitions = await query(
          `delete from transition_events where received_at<now()-interval '30 days'`,
        );
        const devices = await query(
          `delete from devices where last_seen_at<now()-interval '90 days'`,
        );
        return {
          devices: devices.rowCount ?? 0,
          transitions: transitions.rowCount ?? 0,
          notifications:
            (attempts.rowCount ?? 0) +
            (outbox.rowCount ?? 0) +
            (inbox.rowCount ?? 0),
          triggers: triggers.rowCount ?? 0,
        };
      })
      .catch((error) => {
        this.logger.warn(
          `retention failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      });
  }

  async deleteAccount(accountId: string): Promise<{ deleted: true }> {
    await this.db.transaction(async (query) => {
      await query("delete from rate_limit_counters where subject=$1", [
        accountId,
      ]);
      await query("delete from accounts where id=$1", [accountId]);
    });
    return { deleted: true };
  }
}
