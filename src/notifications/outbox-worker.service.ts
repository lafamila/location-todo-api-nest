import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "../config/config.service";
import { Platform } from "../contracts/v1";
import { DatabaseService } from "../database/database.service";
import { RealtimeService } from "../realtime/realtime.service";
import { DeliveryResult, FcmService } from "./fcm.service";

interface OutboxRow {
  id: string;
  device_id: string;
  attempt_count: number;
  payload: Record<string, unknown>;
  account_id: string;
  platform: Platform;
  push_token: string | null;
}

@Injectable()
export class OutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(OutboxWorkerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly fcm: FcmService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    if (!this.config.value.workerEnabled) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.config.value.workerPollMs,
    );
    this.timer.unref?.();
    void this.recover();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<boolean> {
    await this.db.query(
      `update notification_outbox set status='PENDING',locked_at=null
       where status='SENDING' and locked_at<now()-interval '5 minutes'`,
    );
    const claimed = await this.db.transaction(async (query) => {
      const result = await query<OutboxRow>(
        `select o.id,o.device_id,o.attempt_count,o.payload,d.account_id,d.platform,d.push_token
         from notification_outbox o join devices d on d.id=o.device_id
         where o.status='PENDING' and o.next_attempt_at<=now() order by o.next_attempt_at,o.id
         for update of o skip locked limit 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
      await query(
        `update notification_outbox set status='SENDING',locked_at=now(),attempt_count=attempt_count+1 where id=$1`,
        [row.id],
      );
      return row;
    });
    if (!claimed) return false;
    let delivery: DeliveryResult;
    if (["ios", "android"].includes(claimed.platform)) {
      delivery = claimed.push_token
        ? await this.fcm.send(claimed.push_token, claimed.payload)
        : {
            ok: false,
            terminal: true,
            code: "PUSH_TOKEN_MISSING",
            error: "Push token is not registered",
          };
    } else {
      const delivered = await this.realtime.deliver(
        claimed.id,
        claimed.account_id,
        claimed.device_id,
        claimed.payload,
      );
      delivery = delivered
        ? { ok: true, terminal: false }
        : {
            ok: false,
            terminal: false,
            code: "NO_ACTIVE_SESSION",
            error: "No active session is connected for the target device",
          };
    }
    await this.db.transaction(async (query) => {
      const attempt = claimed.attempt_count + 1;
      await query(
        `insert into delivery_attempts(outbox_id,attempt_number,outcome,provider_status,error_code)
         values($1,$2,$3,$4,$5) on conflict(outbox_id,attempt_number) do nothing`,
        [
          claimed.id,
          attempt,
          delivery.ok
            ? "SENT"
            : delivery.terminal
              ? "TERMINAL_FAILURE"
              : "RETRY",
          delivery.status ?? null,
          delivery.code ?? null,
        ],
      );
      if (delivery.ok) {
        await query(
          `update notification_outbox set status='SENT',sent_at=now(),locked_at=null,last_error=null where id=$1`,
          [claimed.id],
        );
      } else if (delivery.terminal || attempt >= 8) {
        await query(
          `update notification_outbox set status='FAILED',locked_at=null,last_error=$2 where id=$1`,
          [claimed.id, delivery.error ?? delivery.code],
        );
        if (delivery.code === "INVALID_TOKEN") {
          await query(
            `update devices set push_token=null,push_token_updated_at=null where id=$1`,
            [claimed.device_id],
          );
        }
      } else {
        const delaySeconds = Math.min(3600, 2 ** attempt * 5);
        await query(
          `update notification_outbox set status='PENDING',locked_at=null,last_error=$2,next_attempt_at=now()+($3*interval '1 second') where id=$1`,
          [claimed.id, delivery.error ?? delivery.code, delaySeconds],
        );
      }
    });
    return true;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let count = 0; count < 20 && (await this.runOnce()); count += 1)
        continue;
    } catch (error) {
      this.logger.warn(
        `outbox worker cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async recover(): Promise<void> {
    await this.db
      .query(
        `update notification_outbox set status='PENDING',locked_at=null where status='SENDING' and locked_at<now()-interval '5 minutes'`,
      )
      .catch((error: unknown) =>
        this.logger.warn(
          `outbox recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }
}
