import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  Notification,
  Pool,
  PoolClient,
  QueryResult,
  QueryResultRow,
} from "pg";
import { ConfigService } from "../config/config.service";

export type Query = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: readonly unknown[],
) => Promise<QueryResult<T>>;

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly pool: Pool;

  constructor(config: ConfigService) {
    this.pool = new Pool({
      connectionString: config.value.databaseUrl,
      ssl: config.value.databaseSsl ? { rejectUnauthorized: false } : undefined,
      max: 12,
    });
  }

  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.pool.query<T>(sql, [...params]);
  }

  async transaction<T>(
    work: (query: Query, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const query: Query = (sql, params = []) => client.query(sql, [...params]);
    try {
      await client.query("begin");
      const result = await work(query, client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async migrationStatus(): Promise<{
    current: string | null;
    pending: number;
  }> {
    const table = await this.query<{ exists: boolean }>(
      `select to_regclass('public.schema_migrations') is not null as exists`,
    );
    if (!table.rows[0]?.exists) return { current: null, pending: -1 };
    const applied = await this.query<{ version: string }>(
      "select version from schema_migrations order by version",
    );
    const { migrationFiles } = await import("./migrations");
    const versions = new Set(applied.rows.map((row) => row.version));
    return {
      current: applied.rows.at(-1)?.version ?? null,
      pending: migrationFiles().filter(
        (file) => !versions.has(file.replace(/\.sql$/, "")),
      ).length,
    };
  }

  async listen(
    channel: string,
    receive: (payload: string) => void,
  ): Promise<() => Promise<void>> {
    if (!/^[a-z_][a-z0-9_]*$/.test(channel))
      throw new Error("PostgreSQL notification channel is invalid");
    let client: PoolClient | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let failures = 0;
    const listener = (notification: Notification) => {
      if (notification.channel === channel && notification.payload)
        receive(notification.payload);
    };
    const scheduleReconnect = () => {
      if (stopped || retryTimer) return;
      const delay = Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
      failures += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void connect();
      }, delay);
      retryTimer.unref?.();
    };
    const detach = (current: PoolClient, destroy: boolean) => {
      current.removeListener("notification", listener);
      current.removeListener("error", failed);
      current.removeListener("end", failed);
      if (client === current) client = undefined;
      current.release(destroy);
    };
    const failed = () => {
      const current = client;
      if (current) detach(current, true);
      scheduleReconnect();
    };
    const connect = async () => {
      if (stopped || client) return;
      let current: PoolClient | undefined;
      try {
        current = await this.pool.connect();
        client = current;
        current.on("notification", listener);
        current.on("error", failed);
        current.on("end", failed);
        await current.query(`listen ${channel}`);
        failures = 0;
      } catch {
        if (current) detach(current, true);
        scheduleReconnect();
      }
    };
    await connect();
    return async () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      const current = client;
      if (!current) return;
      await current.query(`unlisten ${channel}`).catch(() => undefined);
      detach(current, false);
    };
  }

  async notify(channel: string, payload: string): Promise<void> {
    await this.query("select pg_notify($1,$2)", [channel, payload]);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
