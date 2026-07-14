import { Injectable } from "@nestjs/common";
import { ServiceSession } from "../auth/auth.types";
import {
  ApiError,
  requireInteger,
  requireNumber,
  requireUuid,
} from "../common/errors";
import {
  RecurrenceRuleDto,
  TransitionAckDto,
  TransitionEventDto,
} from "../contracts/v1";
import { DatabaseService, Query } from "../database/database.service";
import { TriggerService } from "../notifications/trigger.service";
import {
  occurrenceForObservedDate,
  scheduleEligible,
} from "../todos/recurrence";

interface CandidateRow {
  id: string;
  recurrence_type: RecurrenceRuleDto["type"];
  recurrence_start_date: string | Date;
  recurrence_weekdays: number[];
  recurrence_month_days: number[];
  trigger_type: "ENTRY_IMMEDIATE" | "ENTRY_DELAYED" | "DWELL";
  trigger_minutes: number | null;
  activation_generation: number;
  activated_at: Date;
}

@Injectable()
export class TransitionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly triggers: TriggerService,
  ) {}

  async upload(
    session: ServiceSession,
    input: { events: TransitionEventDto[] },
  ): Promise<{ acks: TransitionAckDto[] }> {
    if (!session.deviceId)
      throw new ApiError(
        "DEVICE_REQUIRED",
        "Register this device before uploading transitions",
        409,
      );
    if (
      session.source !== "header" ||
      !session.platform ||
      !["ios", "android"].includes(session.platform)
    ) {
      throw new ApiError(
        "MOBILE_DEVICE_REQUIRED",
        "Only active iOS or Android device sessions may upload transitions",
        403,
      );
    }
    if (
      !input ||
      !Array.isArray(input.events) ||
      input.events.length < 1 ||
      input.events.length > 200
    ) {
      throw new ApiError(
        "VALIDATION_ERROR",
        "events must contain 1..200 entries",
      );
    }
    const events = input.events
      .map(validateEvent)
      .sort((a, b) => a.sequence - b.sequence);
    for (let index = 1; index < events.length; index += 1) {
      if (events[index]!.sequence <= events[index - 1]!.sequence) {
        throw new ApiError(
          "VALIDATION_ERROR",
          "event sequences must be unique and increasing",
        );
      }
    }
    return this.db.transaction(async (query) => {
      await query(`select pg_advisory_xact_lock(hashtext($1))`, [
        `location-todo:transition:${session.deviceId}`,
      ]);
      const device = await query<{ last_transition_sequence: string }>(
        `select last_transition_sequence::text from devices where id=$1 and account_id=$2 and active
         and platform=$3 and platform in ('ios','android')`,
        [session.deviceId, session.account.id, session.platform],
      );
      if (!device.rowCount)
        throw new ApiError("DEVICE_NOT_FOUND", "Active device not found", 404);
      let lastSequence = Number(device.rows[0]!.last_transition_sequence);
      const acknowledgements: TransitionAckDto[] = [];
      for (const event of events) {
        const existing = await this.findReplay(session, event, query);
        if (existing) {
          acknowledgements.push(existing);
          continue;
        }
        if (event.sequence <= lastSequence) {
          throw new ApiError(
            "DEVICE_SEQUENCE_OUT_OF_ORDER",
            "Transition sequence must increase monotonically",
            409,
            { sequence: event.sequence, lastAcceptedSequence: lastSequence },
          );
        }
        acknowledgements.push(await this.applyEvent(session, event, query));
        lastSequence = event.sequence;
      }
      await query(
        `update devices set last_transition_sequence=$2 where id=$1`,
        [session.deviceId, lastSequence],
      );
      return { acks: acknowledgements };
    });
  }

  private async findReplay(
    session: ServiceSession,
    event: TransitionEventDto,
    query: Query,
  ): Promise<TransitionAckDto | null> {
    const existing = await query<{
      id: string;
      device_id: string;
      device_sequence: string;
      geofence_id: string;
      transition: string;
      observed_at: Date;
      accuracy_meters: number | null;
      disposition: string;
    }>(
      `select event_id id,device_id,device_sequence,geofence_id,transition,observed_at,accuracy_meters,disposition
       from transition_idempotency_keys where event_id=$2 or (device_id=$1 and device_sequence=$3)`,
      [session.deviceId, event.id, event.sequence],
    );
    if (existing.rows.length > 1) {
      throw new ApiError(
        "EVENT_REPLAY_CONFLICT",
        "Transition event ID and sequence identify different stored events",
        409,
        { eventId: event.id, sequence: event.sequence },
      );
    }
    const row = existing.rows[0];
    if (!row) return null;
    const exact =
      row.id === event.id &&
      row.device_id === session.deviceId &&
      Number(row.device_sequence) === event.sequence &&
      row.geofence_id === event.geofenceId &&
      row.transition === event.transition &&
      row.observed_at.getTime() === new Date(event.observedAt).getTime() &&
      row.accuracy_meters === (event.accuracyMeters ?? null);
    if (!exact) {
      throw new ApiError(
        "EVENT_REPLAY_CONFLICT",
        "Transition event ID or sequence was replayed with different data",
        409,
        { eventId: event.id, sequence: event.sequence },
      );
    }
    return {
      id: event.id,
      sequence: event.sequence,
      status: "DUPLICATE",
      disposition: row.disposition,
    };
  }

  private async applyEvent(
    session: ServiceSession,
    event: TransitionEventDto,
    query: Query,
  ): Promise<TransitionAckDto> {
    const geofence = await query(
      "select 1 from saved_geofences where id=$1 and account_id=$2 and deleted_at is null",
      [event.geofenceId, session.account.id],
    );
    if (!geofence.rowCount) {
      await this.recordEvent(session, event, "GEOFENCE_UNAVAILABLE", query);
      return {
        id: event.id,
        sequence: event.sequence,
        status: "IGNORED",
        disposition: "GEOFENCE_UNAVAILABLE",
      };
    }
    const candidates = await query<CandidateRow>(
      `select t.id,t.recurrence_type,t.recurrence_start_date,t.recurrence_weekdays,t.recurrence_month_days,
       t.trigger_type,t.trigger_minutes,t.activation_generation,t.activated_at
       from todos t join todo_geofences tg on tg.todo_id=t.id
       where tg.geofence_id=$1 and t.account_id=$2 and t.deleted_at is null and t.active
       and t.lifecycle_status in ('ACTIVE','TRIGGERED') for update of t`,
      [event.geofenceId, session.account.id],
    );
    let disposition = candidates.rowCount ? "STATE_UPDATED" : "NO_ACTIVE_TODO";
    for (const todo of candidates.rows) {
      const result = await this.applyToTodo(
        todo,
        session.deviceId!,
        event,
        query,
      );
      if (result !== "STATE_UPDATED") disposition = result;
    }
    await this.recordEvent(session, event, disposition, query);
    return {
      id: event.id,
      sequence: event.sequence,
      status: "ACCEPTED",
      disposition,
    };
  }

  private async applyToTodo(
    todo: CandidateRow,
    deviceId: string,
    event: TransitionEventDto,
    query: Query,
  ): Promise<string> {
    if (new Date(event.observedAt).getTime() < todo.activated_at.getTime())
      return "BEFORE_ACTIVATION";
    const current = await query<{
      activation_generation: number;
      state: "unknown" | "inside" | "outside";
      armed: boolean;
      entered_at: Date | null;
    }>(
      `select activation_generation,state,armed,entered_at from device_geofence_states
       where todo_id=$1 and device_id=$2 and geofence_id=$3 for update`,
      [todo.id, deviceId, event.geofenceId],
    );
    const previous = current.rows[0];
    const sameGeneration =
      previous?.activation_generation === todo.activation_generation;
    if (event.transition === "EXIT") {
      const pendingOccurrences = await query<{ id: string }>(
        `select id from todo_occurrences where todo_id=$1 and status='PENDING' for update`,
        [todo.id],
      );
      const occurrenceIds = pendingOccurrences.rows.map((row) => row.id);
      if (
        sameGeneration &&
        previous?.state === "inside" &&
        previous.entered_at
      ) {
        const matured = occurrenceIds.length
          ? await query<{
              job_id: string;
              occurrence_id: string;
              due_at: Date;
            }>(
              `select j.id job_id,j.occurrence_id,j.due_at from due_jobs j
               where j.kind='DWELL' and j.device_id=$1 and j.geofence_id=$2
               and j.occurrence_id=any($3::uuid[]) and j.status='PENDING' and j.due_at<=$4
               order by j.due_at for update`,
              [deviceId, event.geofenceId, occurrenceIds, event.observedAt],
            )
          : { rows: [] };
        for (const job of matured.rows) {
          await this.triggers.emit(query, {
            occurrenceId: job.occurrence_id,
            sourceType: "DWELL",
            sourceId: job.job_id,
            triggeredAt: job.due_at,
          });
          await query(`update due_jobs set status='DONE' where id=$1`, [
            job.job_id,
          ]);
        }
      }
      await query(
        `insert into device_geofence_states(todo_id,device_id,geofence_id,activation_generation,state,armed,entered_at,updated_at)
         values($1,$2,$3,$4,'outside',true,null,$5)
         on conflict(todo_id,device_id,geofence_id) do update set activation_generation=excluded.activation_generation,
         state='outside',armed=true,entered_at=null,updated_at=excluded.updated_at`,
        [
          todo.id,
          deviceId,
          event.geofenceId,
          todo.activation_generation,
          event.observedAt,
        ],
      );
      if (occurrenceIds.length)
        await query(
          `update due_jobs set status='CANCELLED' where kind='DWELL' and device_id=$1 and geofence_id=$2
           and status='PENDING' and occurrence_id=any($3::uuid[])`,
          [deviceId, event.geofenceId, occurrenceIds],
        );
      return "ARMED_OUTSIDE";
    }
    const validEntry =
      sameGeneration &&
      previous?.armed === true &&
      previous.state === "outside";
    await query(
      `insert into device_geofence_states(todo_id,device_id,geofence_id,activation_generation,state,armed,entered_at,updated_at)
       values($1,$2,$3,$4,'inside',false,$5,$5)
       on conflict(todo_id,device_id,geofence_id) do update set activation_generation=excluded.activation_generation,
       state='inside',armed=false,entered_at=excluded.entered_at,updated_at=excluded.updated_at`,
      [
        todo.id,
        deviceId,
        event.geofenceId,
        todo.activation_generation,
        event.observedAt,
      ],
    );
    if (!validEntry) return "ENTER_NOT_ARMED";
    const recurrence: RecurrenceRuleDto = {
      type: todo.recurrence_type,
      startDate: dateString(todo.recurrence_start_date),
      weekdays: todo.recurrence_weekdays,
      monthDays: todo.recurrence_month_days,
    };
    const windows = await query<{
      local_date: string | Date | null;
      start_time: string;
      end_minute: number;
    }>(
      "select local_date,start_time,end_minute from todo_schedule_windows where todo_id=$1",
      [todo.id],
    );
    const fixedDates = windows.rows
      .map((window) =>
        window.local_date ? dateString(window.local_date) : null,
      )
      .filter((value): value is string => Boolean(value));
    const hasUndatedWindow = windows.rows.some((window) => !window.local_date);
    const occurrence = occurrenceForObservedDate(
      recurrence,
      new Date(event.observedAt),
      recurrence.type === "ONCE"
        ? {
            openEnded: fixedDates.length === 0 || hasUndatedWindow,
            fixedDates,
          }
        : undefined,
    );
    if (!occurrence) return "RECURRENCE_INELIGIBLE";
    if (
      !scheduleEligible(
        new Date(event.observedAt),
        windows.rows.map((window) => ({
          date: window.local_date ? dateString(window.local_date) : null,
          startTime: window.start_time.slice(0, 5),
          endTime: minuteTime(window.end_minute),
        })),
      )
    ) {
      return "SCHEDULE_INELIGIBLE";
    }
    const occurrenceResult = await query<{ id: string; status: string }>(
      `insert into todo_occurrences(todo_id,occurrence_key) values($1,$2)
       on conflict(todo_id,occurrence_key) do update set status='PENDING',triggered_at=null
       where todo_occurrences.status<>'TRIGGERED' returning id,status`,
      [
        todo.id,
        recurrence.type === "ONCE"
          ? `${occurrence.occurrenceKey}:${todo.activation_generation}`
          : occurrence.occurrenceKey,
      ],
    );
    const occurrenceRow = occurrenceResult.rows[0];
    if (!occurrenceRow) return "OCCURRENCE_ALREADY_RESOLVED";
    if (occurrenceRow.status !== "PENDING")
      return "OCCURRENCE_ALREADY_RESOLVED";
    if (todo.trigger_type === "ENTRY_IMMEDIATE") {
      const emitted = await this.triggers.emit(query, {
        occurrenceId: occurrenceRow.id,
        sourceType: "ENTRY_IMMEDIATE",
        sourceId: event.id,
        triggeredAt: new Date(event.observedAt),
      });
      return emitted.emitted ? "TRIGGERED" : "OCCURRENCE_ALREADY_TRIGGERED";
    }
    const kind = todo.trigger_type === "ENTRY_DELAYED" ? "DELAYED" : "DWELL";
    const dueAt = new Date(
      new Date(event.observedAt).getTime() +
        (todo.trigger_minutes ?? 0) * 60_000,
    );
    const job = await query(
      kind === "DELAYED"
        ? `insert into due_jobs(occurrence_id,kind,due_at,device_id,geofence_id) values($1,'DELAYED',$2,$3,$4)
           on conflict(occurrence_id,kind) where kind in ('TIME','DELAYED') do update
           set due_at=excluded.due_at,device_id=excluded.device_id,geofence_id=excluded.geofence_id,
           status='PENDING',locked_at=null,last_error=null where due_jobs.status='CANCELLED'`
        : `insert into due_jobs(occurrence_id,kind,due_at,device_id,geofence_id) values($1,'DWELL',$2,$3,$4)
           on conflict(occurrence_id,kind,device_id,geofence_id) where kind='DWELL' do update set due_at=excluded.due_at,status='PENDING'`,
      [occurrenceRow.id, dueAt, deviceId, event.geofenceId],
    );
    return job.rowCount ? `${kind}_SCHEDULED` : `${kind}_ALREADY_SCHEDULED`;
  }

  private async recordEvent(
    session: ServiceSession,
    event: TransitionEventDto,
    disposition: string,
    query: Query,
  ): Promise<void> {
    await query(
      `insert into transition_idempotency_keys
       (event_id,device_id,device_sequence,geofence_id,transition,observed_at,accuracy_meters,disposition)
       values($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        event.id,
        session.deviceId,
        event.sequence,
        event.geofenceId,
        event.transition,
        event.observedAt,
        event.accuracyMeters ?? null,
        disposition,
      ],
    );
    await query(
      `insert into transition_events(id,account_id,device_id,device_sequence,geofence_id,transition,observed_at,accuracy_meters,disposition)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        event.id,
        session.account.id,
        session.deviceId,
        event.sequence,
        event.geofenceId,
        event.transition,
        event.observedAt,
        event.accuracyMeters ?? null,
        disposition,
      ],
    );
  }
}

function validateEvent(event: TransitionEventDto): TransitionEventDto {
  requireUuid(event.id, "event.id");
  requireInteger(event.sequence, "event.sequence", 0, Number.MAX_SAFE_INTEGER);
  requireUuid(event.geofenceId, "event.geofenceId");
  if (!["ENTER", "EXIT"].includes(event.transition))
    throw new ApiError("VALIDATION_ERROR", "event.transition is invalid");
  const observedAt = new Date(event.observedAt);
  if (!Number.isFinite(observedAt.getTime()))
    throw new ApiError("VALIDATION_ERROR", "event.observedAt is invalid");
  if (observedAt.getTime() > Date.now() + 5 * 60_000)
    throw new ApiError(
      "VALIDATION_ERROR",
      "event.observedAt is too far in the future",
    );
  if (event.accuracyMeters !== undefined)
    requireNumber(event.accuracyMeters, "event.accuracyMeters", 0, 5000);
  return { ...event, observedAt: observedAt.toISOString() };
}

function dateString(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value).slice(0, 10);
}

function minuteTime(value: number): string {
  return value === 1440
    ? "24:00"
    : `${Math.floor(value / 60)
        .toString()
        .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
