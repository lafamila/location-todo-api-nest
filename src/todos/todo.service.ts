import { Injectable } from "@nestjs/common";
import { AuthAccount } from "../auth/auth.types";
import {
  ApiError,
  requireInteger,
  requireString,
  requireUuid,
} from "../common/errors";
import { lockMonitoringGraph } from "../common/monitoring-lock";
import {
  RecurrenceRuleDto,
  ScheduleWindowDto,
  TodoDto,
  TriggerConditionDto,
} from "../contracts/v1";
import { ConfigService } from "../config/config.service";
import { DatabaseService, Query } from "../database/database.service";
import { QuotaService } from "../quota/quota.service";
import {
  nextOccurrence,
  normalizeRule,
  timeMinute,
  validateLocalTime,
  validateWindows,
} from "./recurrence";

interface TodoRow {
  id: string;
  account_id: string;
  content: string;
  is_location: boolean;
  recurrence_type: RecurrenceRuleDto["type"];
  recurrence_start_date: string | Date;
  recurrence_weekdays: number[];
  recurrence_month_days: number[];
  local_time: string | null;
  trigger_type: TriggerConditionDto["type"] | null;
  trigger_minutes: number | null;
  active: boolean;
  lifecycle_status: TodoDto["lifecycleStatus"];
  next_occurrence_at: Date | null;
  last_triggered_at: Date | null;
  completed_at: Date | null;
  deleted_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

interface WindowRow {
  local_date: string | Date | null;
  start_time: string;
  end_minute: number;
}

export interface TodoInput {
  content: string;
  recurrence: RecurrenceRuleDto;
  localTime?: string | null;
  triggerCondition?: TriggerConditionDto | null;
  scheduleWindows?: ScheduleWindowDto[];
  geofenceIds?: string[];
}

interface ValidatedTodoInput {
  content: string;
  isLocation: boolean;
  recurrence: RecurrenceRuleDto;
  localTime: string | null;
  triggerType: TriggerConditionDto["type"] | null;
  triggerMinutes: number | null;
  scheduleWindows: ScheduleWindowDto[];
  geofenceIds: string[];
}

@Injectable()
export class TodoService {
  constructor(
    private readonly db: DatabaseService,
    private readonly quota: QuotaService,
    private readonly config: ConfigService,
  ) {}

  async list(accountId: string, deleted = false): Promise<TodoDto[]> {
    const result = await this.db.query<TodoRow>(
      `${todoSelect()} where t.account_id=$1 and ${deleted ? "t.deleted_at is not null" : "t.deleted_at is null"} order by t.updated_at desc`,
      [accountId],
    );
    return Promise.all(result.rows.map((row) => this.toDto(row)));
  }

  async get(accountId: string, id: string): Promise<TodoDto> {
    const row = await this.requireOwned(accountId, id);
    return this.toDto(row);
  }

  async create(account: AuthAccount, input: TodoInput): Promise<TodoDto> {
    const value = this.validateInput(input);
    const id = await this.db.transaction(async (query) => {
      await lockMonitoringGraph(account.id, query);
      if (value.isLocation)
        await this.quota.assertAvailable(account, "locationTodo", query);
      else await this.consumeTimeMutation(account.id, query);
      await this.assertGeofences(account.id, value.geofenceIds, query);
      const result = await query<{ id: string }>(
        `insert into todos(account_id,content,recurrence_type,recurrence_start_date,
         recurrence_weekdays,recurrence_month_days,local_time,trigger_type,trigger_minutes)
         values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          account.id,
          value.content,
          value.recurrence.type,
          value.recurrence.startDate,
          value.recurrence.weekdays ?? [],
          value.recurrence.monthDays ?? [],
          value.localTime,
          value.triggerType,
          value.triggerMinutes,
        ],
      );
      const todoId = result.rows[0]!.id;
      await this.replaceRelations(todoId, value, query);
      if (!value.isLocation)
        await this.scheduleNext(todoId, value, new Date(), query);
      return todoId;
    });
    return this.get(account.id, id);
  }

  async update(
    account: AuthAccount,
    id: string,
    input: TodoInput & { version: number },
  ): Promise<TodoDto> {
    requireUuid(id, "todoId");
    const value = this.validateInput(input);
    const version = requireInteger(input.version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(account.id, query);
      const currentResult = await query<TodoRow>(
        `${todoSelect()} where t.id=$1 and t.account_id=$2 for update of t`,
        [id, account.id],
      );
      const current = currentResult.rows[0];
      if (!current) throw new ApiError("TODO_NOT_FOUND", "TODO not found", 404);
      if (current.deleted_at)
        throw new ApiError(
          "TODO_DELETED",
          "Restore the TODO before editing it",
          409,
        );
      if (current.version !== version)
        throw new ApiError("VERSION_CONFLICT", "TODO version changed", 409, {
          currentVersion: current.version,
        });
      if (value.isLocation && !current.is_location)
        await this.quota.assertAvailable(account, "locationTodo", query);
      if (!value.isLocation) await this.consumeTimeMutation(account.id, query);
      await this.assertGeofences(account.id, value.geofenceIds, query);
      await query(
        `update todos set content=$3,recurrence_type=$4,recurrence_start_date=$5,
         recurrence_weekdays=$6,recurrence_month_days=$7,local_time=$8,trigger_type=$9,trigger_minutes=$10,
         activation_generation=activation_generation+1,activated_at=now(),
         version=version+1,updated_at=now(),next_occurrence_at=null where id=$1 and account_id=$2`,
        [
          id,
          account.id,
          value.content,
          value.recurrence.type,
          value.recurrence.startDate,
          value.recurrence.weekdays ?? [],
          value.recurrence.monthDays ?? [],
          value.localTime,
          value.triggerType,
          value.triggerMinutes,
        ],
      );
      await this.replaceRelations(id, value, query);
      await this.cancelPending(id, query);
      if (!value.isLocation && current.active && !current.completed_at)
        await this.scheduleNext(id, value, new Date(), query);
    });
    return this.get(account.id, id);
  }

  async setActive(
    accountId: string,
    id: string,
    active: boolean,
    version: number,
  ): Promise<TodoDto> {
    requireUuid(id, "todoId");
    if (typeof active !== "boolean")
      throw new ApiError("VALIDATION_ERROR", "active must be a boolean");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(accountId, query);
      const result = await query<TodoRow>(
        `${todoSelect()} where t.id=$1 and t.account_id=$2 for update of t`,
        [id, accountId],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError("TODO_NOT_FOUND", "TODO not found", 404);
      if (row.deleted_at)
        throw new ApiError("TODO_DELETED", "Restore the TODO first", 409);
      if (row.version !== version)
        throw new ApiError("VERSION_CONFLICT", "TODO version changed", 409, {
          currentVersion: row.version,
        });
      if (["COMPLETED", "TRIGGERED"].includes(row.lifecycle_status))
        throw new ApiError(
          "TODO_REACTIVATION_REQUIRED",
          "Use reactivate for completed or triggered TODOs",
          409,
        );
      if (active) this.assertFutureTimeActivation(row);
      if (active && row.is_location)
        await this.assertLinkedGeofences(id, accountId, query);
      if (!row.is_location) await this.consumeTimeMutation(accountId, query);
      await query(
        `update todos set active=$3,lifecycle_status=$4,activation_generation=activation_generation+1,
         activated_at=case when $3 then now() else activated_at end,
         next_occurrence_at=null,version=version+1,updated_at=now() where id=$1 and account_id=$2`,
        [id, accountId, active, active ? "ACTIVE" : "INACTIVE"],
      );
      await this.cancelPending(id, query);
      if (active && !row.is_location)
        await this.scheduleNext(id, fromRow(row), new Date(), query);
    });
    return this.get(accountId, id);
  }

  async complete(
    accountId: string,
    id: string,
    version: number,
  ): Promise<TodoDto> {
    requireUuid(id, "todoId");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(accountId, query);
      const current = await query<TodoRow>(
        `${todoSelect()} where t.id=$1 and t.account_id=$2 for update of t`,
        [id, accountId],
      );
      const row = current.rows[0];
      if (!row) throw new ApiError("TODO_NOT_FOUND", "TODO not found", 404);
      if (row.deleted_at || row.version !== version)
        throw new ApiError(
          "VERSION_CONFLICT",
          "TODO cannot be completed with this version",
          409,
        );
      if (!row.is_location) await this.consumeTimeMutation(accountId, query);
      await query(
        `update todos set active=false,lifecycle_status='COMPLETED',completed_at=now(),next_occurrence_at=null,
         activation_generation=activation_generation+1,version=version+1,updated_at=now()
         where id=$1`,
        [id],
      );
      await this.cancelPending(id, query);
    });
    return this.get(accountId, id);
  }

  async reactivate(
    account: AuthAccount,
    id: string,
    version: number,
  ): Promise<TodoDto> {
    requireUuid(id, "todoId");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(account.id, query);
      const result = await query<TodoRow>(
        `${todoSelect()} where t.id=$1 and t.account_id=$2 for update of t`,
        [id, account.id],
      );
      const row = result.rows[0];
      if (!row) throw new ApiError("TODO_NOT_FOUND", "TODO not found", 404);
      if (row.deleted_at)
        throw new ApiError("TODO_DELETED", "Restore the TODO first", 409);
      if (row.version !== version)
        throw new ApiError("VERSION_CONFLICT", "TODO version changed", 409, {
          currentVersion: row.version,
        });
      if (!["COMPLETED", "TRIGGERED"].includes(row.lifecycle_status))
        throw new ApiError(
          "TODO_REACTIVATION_NOT_AVAILABLE",
          "Only completed or triggered TODOs can be reactivated",
          409,
        );
      this.assertFutureTimeActivation(row);
      if (row.is_location)
        await this.assertLinkedGeofences(id, account.id, query);
      if (!row.is_location) await this.consumeTimeMutation(account.id, query);
      await query(
        `update todos set active=true,lifecycle_status='ACTIVE',completed_at=null,next_occurrence_at=null,activated_at=now(),
         activation_generation=activation_generation+1,version=version+1,updated_at=now() where id=$1`,
        [id],
      );
      await this.cancelPending(id, query);
      if (!row.is_location)
        await this.scheduleNext(id, fromRow(row), new Date(), query);
    });
    return this.get(account.id, id);
  }

  async remove(
    accountId: string,
    id: string,
    version: number,
  ): Promise<{ ok: true }> {
    requireUuid(id, "todoId");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(accountId, query);
      const current = await query<TodoRow>(
        `${todoSelect()} where t.id=$1 and t.account_id=$2 for update of t`,
        [id, accountId],
      );
      const row = current.rows[0];
      if (!row) throw new ApiError("TODO_NOT_FOUND", "TODO not found", 404);
      if (row.deleted_at || row.version !== version)
        throw new ApiError(
          "VERSION_CONFLICT",
          "TODO cannot be deleted with this version",
          409,
        );
      if (!row.is_location) await this.consumeTimeMutation(accountId, query);
      await query(
        `update todos set active=false,lifecycle_status='INACTIVE',deleted_at=now(),next_occurrence_at=null,
         activation_generation=activation_generation+1,version=version+1,updated_at=now()
         where id=$1`,
        [id],
      );
      await this.cancelPending(id, query);
    });
    return { ok: true };
  }

  async restore(
    account: AuthAccount,
    id: string,
    version: number,
  ): Promise<TodoDto> {
    requireUuid(id, "todoId");
    version = requireInteger(version, "version", 1, 2_147_483_647);
    await this.db.transaction(async (query) => {
      await lockMonitoringGraph(account.id, query);
      const result = await query<TodoRow>(
        `${todoSelect()} where t.id=$1 and t.account_id=$2 for update of t`,
        [id, account.id],
      );
      const row = result.rows[0];
      if (!row || !row.deleted_at)
        throw new ApiError("TODO_NOT_FOUND", "Deleted TODO not found", 404);
      if (row.version !== version)
        throw new ApiError("VERSION_CONFLICT", "TODO version changed", 409, {
          currentVersion: row.version,
        });
      if (row.is_location)
        await this.quota.assertAvailable(account, "locationTodo", query);
      else await this.consumeTimeMutation(account.id, query);
      await query(
        `update todos set deleted_at=null,active=false,lifecycle_status='INACTIVE',completed_at=null,next_occurrence_at=null,
         activation_generation=activation_generation+1,version=version+1,updated_at=now() where id=$1`,
        [id],
      );
    });
    return this.get(account.id, id);
  }

  private validateInput(input: TodoInput): ValidatedTodoInput {
    if (!input || typeof input !== "object")
      throw new ApiError("VALIDATION_ERROR", "TODO body is required");
    const content = requireString(input.content, "content", 500);
    const recurrence = normalizeRule(input.recurrence);
    if (input.geofenceIds !== undefined && !Array.isArray(input.geofenceIds))
      throw new ApiError("VALIDATION_ERROR", "geofenceIds must be an array");
    const ids = [...new Set(input.geofenceIds ?? [])];
    if (ids.length > 20)
      throw new ApiError(
        "VALIDATION_ERROR",
        "TODO accepts at most 20 geofenceIds",
      );
    ids.forEach((id) => requireUuid(id, "geofenceId"));
    const isLocation = ids.length > 0;
    if (!isLocation) {
      if (input.scheduleWindows?.length || input.triggerCondition) {
        throw new ApiError(
          "TODO_FIELD_MISMATCH",
          "A TODO without saved places cannot contain location fields",
        );
      }
      const localTime = validateLocalTime(
        requireString(input.localTime, "localTime", 5, 5),
      );
      const next = nextOccurrence(recurrence, localTime, new Date());
      if (recurrence.type === "ONCE" && !next) {
        throw new ApiError(
          "PAST_ONCE_OCCURRENCE",
          "TIME ONCE occurrence must be in the future",
        );
      }
      return {
        content,
        isLocation,
        recurrence,
        localTime,
        triggerType: null,
        triggerMinutes: null,
        scheduleWindows: [],
        geofenceIds: [],
      };
    }
    if (input.localTime)
      throw new ApiError(
        "TODO_FIELD_MISMATCH",
        "A TODO with saved places cannot contain localTime",
      );
    const condition = input.triggerCondition;
    if (
      !condition ||
      !["ENTRY_IMMEDIATE", "ENTRY_DELAYED", "DWELL"].includes(condition.type)
    ) {
      throw new ApiError("VALIDATION_ERROR", "triggerCondition is invalid");
    }
    let triggerMinutes: number | null = null;
    if (condition.type === "ENTRY_DELAYED")
      triggerMinutes = requireInteger(
        condition.delayMinutes,
        "delayMinutes",
        1,
        1440,
      );
    if (condition.type === "DWELL")
      triggerMinutes = requireInteger(
        condition.dwellMinutes,
        "dwellMinutes",
        1,
        1440,
      );
    const scheduleWindows = validateWindows(
      input.scheduleWindows ?? [],
      recurrence.type,
    );
    return {
      content,
      isLocation,
      recurrence,
      localTime: null,
      triggerType: condition.type,
      triggerMinutes,
      scheduleWindows,
      geofenceIds: ids,
    };
  }

  private async replaceRelations(
    todoId: string,
    value: ValidatedTodoInput,
    query: Query,
  ): Promise<void> {
    await query("delete from todo_schedule_windows where todo_id=$1", [todoId]);
    await query("delete from todo_geofences where todo_id=$1", [todoId]);
    for (const window of value.scheduleWindows) {
      await query(
        `insert into todo_schedule_windows(todo_id,local_date,start_time,end_minute) values($1,$2,$3,$4)`,
        [
          todoId,
          window.date ?? null,
          window.startTime,
          timeMinute(window.endTime, true),
        ],
      );
    }
    for (const geofenceId of value.geofenceIds) {
      await query(
        "insert into todo_geofences(todo_id,geofence_id) values($1,$2)",
        [todoId, geofenceId],
      );
    }
  }

  private async assertGeofences(
    accountId: string,
    ids: string[],
    query: Query,
  ): Promise<void> {
    if (!ids.length) return;
    const result = await query<{ id: string }>(
      "select id from saved_geofences where account_id=$1 and deleted_at is null and id=any($2::uuid[])",
      [accountId, ids],
    );
    if (result.rowCount !== ids.length)
      throw new ApiError(
        "GEOFENCE_NOT_FOUND",
        "One or more saved geofences are unavailable",
        409,
      );
  }

  private async assertLinkedGeofences(
    todoId: string,
    accountId: string,
    query: Query,
  ): Promise<void> {
    const result = await query<{ geofence_id: string; available: boolean }>(
      `select tg.geofence_id,(g.id is not null) available from todo_geofences tg
       left join saved_geofences g on g.id=tg.geofence_id and g.account_id=$2 and g.deleted_at is null
       where tg.todo_id=$1`,
      [todoId, accountId],
    );
    if (!result.rowCount || result.rows.some((row) => !row.available))
      throw new ApiError(
        "GEOFENCE_NOT_FOUND",
        "Restore or replace unavailable saved geofences before activation",
        409,
      );
  }

  private assertFutureTimeActivation(row: TodoRow): void {
    if (
      !row.is_location &&
      row.local_time &&
      !nextOccurrence(
        fromRow(row).recurrence,
        row.local_time.slice(0, 5),
        new Date(),
      )
    )
      throw new ApiError(
        "ACTIVATION_REQUIRES_FUTURE_SCHEDULE",
        "Edit the date and time to a future occurrence before activation",
        409,
      );
  }

  private async scheduleNext(
    todoId: string,
    input: ValidatedTodoInput,
    after: Date,
    query: Query,
  ): Promise<void> {
    if (!input.localTime) return;
    const next = nextOccurrence(input.recurrence, input.localTime, after);
    if (!next) {
      await query("update todos set next_occurrence_at=null where id=$1", [
        todoId,
      ]);
      return;
    }
    const occurrence = await query<{ id: string }>(
      `insert into todo_occurrences(todo_id,occurrence_key,due_at) values($1,$2,$3)
       on conflict(todo_id,occurrence_key) do update set due_at=excluded.due_at,status='PENDING',triggered_at=null
       where todo_occurrences.status<>'TRIGGERED' returning id`,
      [todoId, next.occurrenceKey, next.dueAt],
    );
    if (occurrence.rows[0]) {
      await query(
        `insert into due_jobs(occurrence_id,kind,due_at) values($1,'TIME',$2)
         on conflict(occurrence_id,kind) where kind in ('TIME','DELAYED') do update set due_at=excluded.due_at,status='PENDING',last_error=null`,
        [occurrence.rows[0].id, next.dueAt],
      );
    }
    await query("update todos set next_occurrence_at=$2 where id=$1", [
      todoId,
      next.dueAt,
    ]);
  }

  private async cancelPending(todoId: string, query: Query): Promise<void> {
    const occurrences = await query<{ id: string }>(
      `select id from todo_occurrences where todo_id=$1 and status='PENDING' for update`,
      [todoId],
    );
    const occurrenceIds = occurrences.rows.map((row) => row.id);
    if (occurrenceIds.length) {
      await query(
        `update due_jobs set status='CANCELLED' where occurrence_id=any($1::uuid[])
         and status in ('PENDING','RUNNING')`,
        [occurrenceIds],
      );
      await query(
        `update todo_occurrences set status='CANCELLED' where id=any($1::uuid[])`,
        [occurrenceIds],
      );
    }
    await query(`delete from device_geofence_states where todo_id=$1`, [
      todoId,
    ]);
  }

  private async consumeTimeMutation(
    accountId: string,
    query: Query,
  ): Promise<void> {
    const result = await query(
      `insert into rate_limit_counters(scope,subject,window_start,count)
       values('time_todo_mutation',$1,date_trunc('hour',now()),1)
       on conflict(scope,subject,window_start) do update
       set count=rate_limit_counters.count+1
       where rate_limit_counters.count<$2 returning count`,
      [accountId, this.config.value.timeTodoMutationsPerHour],
    );
    if (!result.rowCount)
      throw new ApiError(
        "RATE_LIMITED",
        "TIME TODO mutation rate limit exceeded",
        429,
      );
  }

  private async requireOwned(accountId: string, id: string): Promise<TodoRow> {
    requireUuid(id, "todoId");
    const result = await this.db.query<TodoRow>(
      `${todoSelect()} where t.id=$1 and t.account_id=$2`,
      [id, accountId],
    );
    if (!result.rows[0])
      throw new ApiError("TODO_NOT_FOUND", "TODO not found", 404);
    return result.rows[0];
  }

  private async toDto(row: TodoRow): Promise<TodoDto> {
    const [windows, geofences] = await Promise.all([
      this.db.query<WindowRow>(
        "select local_date,start_time,end_minute from todo_schedule_windows where todo_id=$1 order by local_date nulls first,start_time",
        [row.id],
      ),
      this.db.query<{ geofence_id: string }>(
        "select geofence_id from todo_geofences where todo_id=$1 order by geofence_id",
        [row.id],
      ),
    ]);
    const recurrence: RecurrenceRuleDto = {
      type: row.recurrence_type,
      startDate: dateString(row.recurrence_start_date),
      ...(row.recurrence_type === "WEEKLY"
        ? { weekdays: row.recurrence_weekdays }
        : {}),
      ...(row.recurrence_type === "MONTHLY"
        ? { monthDays: row.recurrence_month_days }
        : {}),
    };
    const triggerCondition: TriggerConditionDto | null =
      row.trigger_type === "ENTRY_IMMEDIATE"
        ? { type: row.trigger_type }
        : row.trigger_type === "ENTRY_DELAYED"
          ? { type: row.trigger_type, delayMinutes: row.trigger_minutes! }
          : row.trigger_type === "DWELL"
            ? { type: row.trigger_type, dwellMinutes: row.trigger_minutes! }
            : null;
    return {
      id: row.id,
      content: row.content,
      recurrence,
      localTime: row.local_time?.slice(0, 5) ?? null,
      triggerCondition,
      scheduleWindows: windows.rows.map((window) => ({
        date: window.local_date ? dateString(window.local_date) : null,
        startTime: window.start_time.slice(0, 5),
        endTime: minuteTime(window.end_minute),
      })),
      geofenceIds: geofences.rows.map((relation) => relation.geofence_id),
      active: row.active,
      lifecycleStatus: row.lifecycle_status,
      version: row.version,
      nextOccurrenceAt: row.next_occurrence_at?.toISOString() ?? null,
      lastTriggeredAt: row.last_triggered_at?.toISOString() ?? null,
      completedAt: row.completed_at?.toISOString() ?? null,
      deletedAt: row.deleted_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}

function fromRow(row: TodoRow): ValidatedTodoInput {
  return {
    content: row.content,
    isLocation: row.is_location,
    recurrence: {
      type: row.recurrence_type,
      startDate: dateString(row.recurrence_start_date),
      weekdays: row.recurrence_weekdays,
      monthDays: row.recurrence_month_days,
    },
    localTime: row.local_time?.slice(0, 5) ?? null,
    triggerType: row.trigger_type,
    triggerMinutes: row.trigger_minutes,
    scheduleWindows: [],
    geofenceIds: [],
  };
}

function todoSelect(): string {
  return `select t.*,
    exists(select 1 from todo_geofences tg where tg.todo_id=t.id) is_location
    from todos t`;
}

function dateString(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function minuteTime(value: number): string {
  if (value === 1440) return "24:00";
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
