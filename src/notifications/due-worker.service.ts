import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "../config/config.service";
import { RecurrenceRuleDto } from "../contracts/v1";
import { DatabaseService, Query } from "../database/database.service";
import { nextOccurrence } from "../todos/recurrence";
import { TriggerService } from "./trigger.service";

interface JobRow {
  id: string;
  occurrence_id: string;
  kind: "TIME" | "DELAYED" | "DWELL";
  due_at: Date;
  device_id: string | null;
  geofence_id: string | null;
  todo_id: string;
  active: boolean;
  deleted_at: Date | null;
  lifecycle_status: string;
  activation_generation: number;
  recurrence_type: RecurrenceRuleDto["type"];
  recurrence_start_date: string | Date;
  recurrence_weekdays: number[];
  recurrence_month_days: number[];
  local_time: string | null;
}

@Injectable()
export class DueWorkerService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly logger = new Logger(DueWorkerService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly db: DatabaseService,
    private readonly triggers: TriggerService,
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
    return this.db.transaction(async (query) => {
      const candidate = await query<{ id: string }>(
        `select id from due_jobs where status='PENDING' and due_at<=now()
         order by due_at,id limit 1`,
      );
      const candidateId = candidate.rows[0]?.id;
      if (!candidateId) return false;
      const authority = await query<{ id: string }>(
        `select j.id from due_jobs j join todo_occurrences o on o.id=j.occurrence_id
         join todos t on t.id=o.todo_id where j.id=$1 and j.status='PENDING'
         for update of t,o`,
        [candidateId],
      );
      if (!authority.rowCount) return true;
      const result = await query<JobRow>(
        `select j.id,j.occurrence_id,j.kind,j.due_at,j.device_id,j.geofence_id,t.id todo_id,t.active,t.deleted_at,
         t.lifecycle_status,t.activation_generation,t.recurrence_type,t.recurrence_start_date,t.recurrence_weekdays,
         t.recurrence_month_days,t.local_time
         from due_jobs j join todo_occurrences o on o.id=j.occurrence_id join todos t on t.id=o.todo_id
         where j.id=$1 and j.status='PENDING' for update of j`,
        [candidateId],
      );
      const job = result.rows[0];
      if (!job) return false;
      await query(
        `update due_jobs set status='RUNNING',locked_at=now(),attempts=attempts+1 where id=$1`,
        [job.id],
      );
      if (
        !job.active ||
        job.deleted_at ||
        !["ACTIVE", "TRIGGERED"].includes(job.lifecycle_status)
      ) {
        await query(`update due_jobs set status='CANCELLED' where id=$1`, [
          job.id,
        ]);
        return true;
      }
      if (job.kind === "DWELL" && !(await this.dwellStillValid(job, query))) {
        await query(`update due_jobs set status='CANCELLED' where id=$1`, [
          job.id,
        ]);
        return true;
      }
      await this.triggers.emit(query, {
        occurrenceId: job.occurrence_id,
        sourceType: job.kind,
        sourceId: job.id,
        triggeredAt: job.due_at,
      });
      await query(
        `update due_jobs set status='DONE',locked_at=null where id=$1`,
        [job.id],
      );
      if (
        job.kind === "TIME" &&
        job.recurrence_type !== "ONCE" &&
        job.local_time
      ) {
        await this.scheduleNextTime(job, query);
      }
      return true;
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let count = 0; count < 20 && (await this.runOnce()); count += 1)
        continue;
    } catch (error) {
      this.logger.warn(
        `due worker cycle failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async recover(): Promise<void> {
    await this.db
      .query(
        `update due_jobs set status='PENDING',locked_at=null where status='RUNNING' and locked_at<now()-interval '5 minutes'`,
      )
      .catch((error) =>
        this.logger.warn(
          `due recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  private async dwellStillValid(job: JobRow, query: Query): Promise<boolean> {
    if (!job.device_id || !job.geofence_id) return false;
    const result = await query<{ entered_at: Date | null }>(
      `select entered_at from device_geofence_states where todo_id=$1 and device_id=$2 and geofence_id=$3
       and activation_generation=$4 and state='inside'`,
      [job.todo_id, job.device_id, job.geofence_id, job.activation_generation],
    );
    return Boolean(
      result.rows[0]?.entered_at &&
      result.rows[0].entered_at.getTime() <= job.due_at.getTime(),
    );
  }

  private async scheduleNextTime(job: JobRow, query: Query): Promise<void> {
    const rule: RecurrenceRuleDto = {
      type: job.recurrence_type,
      startDate: dateString(job.recurrence_start_date),
      weekdays: job.recurrence_weekdays,
      monthDays: job.recurrence_month_days,
    };
    const next = nextOccurrence(rule, job.local_time!.slice(0, 5), job.due_at);
    if (!next) return;
    const occurrence = await query<{ id: string }>(
      `insert into todo_occurrences(todo_id,occurrence_key,due_at) values($1,$2,$3)
       on conflict(todo_id,occurrence_key) do update set due_at=excluded.due_at,status='PENDING',triggered_at=null
       where todo_occurrences.status<>'TRIGGERED' returning id`,
      [job.todo_id, next.occurrenceKey, next.dueAt],
    );
    if (occurrence.rows[0]) {
      await query(
        `insert into due_jobs(occurrence_id,kind,due_at) values($1,'TIME',$2)
         on conflict(occurrence_id,kind) where kind in ('TIME','DELAYED') do nothing`,
        [occurrence.rows[0].id, next.dueAt],
      );
      await query("update todos set next_occurrence_at=$2 where id=$1", [
        job.todo_id,
        next.dueAt,
      ]);
    }
  }
}

function dateString(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}
