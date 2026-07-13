import { Query } from "../database/database.service";

export async function lockMonitoringGraph(
  accountId: string,
  query: Query,
): Promise<void> {
  await query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
    `location-todo-monitoring:${accountId}`,
  ]);
}
