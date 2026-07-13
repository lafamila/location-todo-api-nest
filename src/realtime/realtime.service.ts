import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Namespace } from "socket.io";
import { SessionService } from "../auth/session.service";
import { DatabaseService } from "../database/database.service";

const SIGNAL_CHANNEL = "location_todo_realtime";

interface DeliverySignal {
  outboxId: string;
  accountId: string;
  deviceId: string;
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private server?: Namespace;
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => Promise<void>;
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly db: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = await this.db
      .listen(SIGNAL_CHANNEL, (payload) => {
        void this.receiveSignal(payload).catch((error: unknown) =>
          this.logger.warn(
            `realtime signal delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `realtime database listener unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return undefined;
      });
    this.timer = setInterval(() => void this.sweep(), 30_000);
    this.timer.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.unsubscribe?.();
  }

  attach(server: Namespace): void {
    this.server = server;
  }

  async emit(
    accountId: string,
    deviceId: string,
    payload: Record<string, unknown>,
  ): Promise<number> {
    if (!this.server) return 0;
    const sockets = await this.server.in(`account:${accountId}`).fetchSockets();
    const delivered = await Promise.all(
      sockets.map(async (socket) => {
        if (!(await this.validSocket(socket.data, accountId, deviceId))) {
          socket.disconnect(true);
          return false;
        }
        socket.emit("notification", payload);
        return true;
      }),
    );
    return delivered.filter(Boolean).length;
  }

  async deliver(
    outboxId: string,
    accountId: string,
    deviceId: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    if ((await this.emit(accountId, deviceId, payload)) > 0) {
      await this.recordDelivery(outboxId);
      return true;
    }
    const signal: DeliverySignal = { outboxId, accountId, deviceId };
    await this.db.notify(SIGNAL_CHANNEL, JSON.stringify(signal));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await delay(100);
      const result = await this.db.query<{ delivered: boolean }>(
        `select realtime_delivered_at is not null delivered from notification_outbox where id=$1`,
        [outboxId],
      );
      if (result.rows[0]?.delivered) return true;
    }
    return false;
  }

  async sweep(): Promise<void> {
    if (!this.server) return;
    try {
      const sockets = await this.server.fetchSockets();
      await Promise.all(
        sockets.map(async (socket) => {
          if (!(await this.validSocket(socket.data))) socket.disconnect(true);
        }),
      );
    } catch (error: unknown) {
      this.logger.warn(
        `realtime session sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async validSocket(
    data: Record<string, unknown>,
    expectedAccountId?: string,
    expectedDeviceId?: string,
  ): Promise<boolean> {
    const token =
      typeof data.locationTodoSessionToken === "string"
        ? data.locationTodoSessionToken
        : undefined;
    try {
      const session = await this.sessions.validateExisting(token);
      const socketAccountId = data.locationTodoAccountId;
      const socketDeviceId = data.locationTodoDeviceId;
      return (
        session.account.id === socketAccountId &&
        session.deviceId === socketDeviceId &&
        (!expectedAccountId || session.account.id === expectedAccountId) &&
        (!expectedDeviceId || session.deviceId === expectedDeviceId)
      );
    } catch {
      return false;
    }
  }

  private async receiveSignal(payload: string): Promise<void> {
    let signal: DeliverySignal;
    try {
      signal = JSON.parse(payload) as DeliverySignal;
    } catch {
      return;
    }
    const result = await this.db.query<{
      payload: Record<string, unknown>;
      account_id: string;
      device_id: string;
    }>(
      `select o.payload,d.account_id,o.device_id from notification_outbox o
       join devices d on d.id=o.device_id where o.id=$1 and o.status in ('PENDING','SENDING')
       and o.realtime_delivered_at is null and d.active and d.platform in ('macos','windows','web')`,
      [signal.outboxId],
    );
    const row = result.rows[0];
    if (
      !row ||
      row.account_id !== signal.accountId ||
      row.device_id !== signal.deviceId
    )
      return;
    if ((await this.emit(row.account_id, row.device_id, row.payload)) > 0)
      await this.recordDelivery(signal.outboxId);
  }

  private async recordDelivery(outboxId: string): Promise<void> {
    await this.db.query(
      `update notification_outbox set realtime_delivered_at=coalesce(realtime_delivered_at,now()) where id=$1`,
      [outboxId],
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
