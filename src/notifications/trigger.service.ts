import { Injectable } from "@nestjs/common";
import { Query } from "../database/database.service";

@Injectable()
export class TriggerService {
  async emit(
    query: Query,
    input: {
      occurrenceId: string;
      sourceType: string;
      sourceId?: string | null;
      triggeredAt?: Date;
    },
  ): Promise<{
    emitted: boolean;
    eventId?: string;
    reason?: "TODO_INELIGIBLE" | "OCCURRENCE_RESOLVED" | "ALREADY_TRIGGERED";
  }> {
    const authority = await query<{
      active: boolean;
      deleted_at: Date | null;
      lifecycle_status: string;
      occurrence_status: string;
    }>(
      `select t.active,t.deleted_at,t.lifecycle_status,o.status occurrence_status
       from todo_occurrences o join todos t on t.id=o.todo_id
       where o.id=$1 for update of t,o`,
      [input.occurrenceId],
    );
    const canonical = authority.rows[0];
    if (
      !canonical ||
      !canonical.active ||
      canonical.deleted_at ||
      !["ACTIVE", "TRIGGERED"].includes(canonical.lifecycle_status)
    ) {
      return { emitted: false, reason: "TODO_INELIGIBLE" };
    }
    if (canonical.occurrence_status !== "PENDING") {
      return { emitted: false, reason: "OCCURRENCE_RESOLVED" };
    }
    const guard = await query(
      `insert into todo_trigger_guards(occurrence_id,source_type,source_id) values($1,$2,$3)
       on conflict(occurrence_id) do nothing`,
      [input.occurrenceId, input.sourceType, input.sourceId ?? null],
    );
    if (!guard.rowCount) return { emitted: false, reason: "ALREADY_TRIGGERED" };
    const event = await query<{
      id: string;
      account_id: string;
      todo_id: string;
      occurrence_key: string;
      content: string;
      triggered_at: Date;
    }>(
      `insert into trigger_events(account_id,todo_id,occurrence_id,occurrence_key,content,source_type,triggered_at)
       select t.account_id,t.id,o.id,o.occurrence_key,t.content,$2,coalesce($3,now())
       from todo_occurrences o join todos t on t.id=o.todo_id where o.id=$1
       returning id,account_id,todo_id,occurrence_key,content,triggered_at`,
      [input.occurrenceId, input.sourceType, input.triggeredAt ?? null],
    );
    const row = event.rows[0];
    if (!row)
      throw new Error("Occurrence disappeared during trigger transaction");
    const inbox = await query<{ id: string; cursor: string }>(
      `insert into notification_inbox(account_id,trigger_event_id,payload)
       values($1::uuid,$2::uuid,jsonb_build_object('type','TODO_TRIGGERED','eventId',$2::uuid::text,'todoId',$3::uuid::text,
       'occurrenceKey',$4::text,'content',$5::text,'triggeredAt',$6::timestamptz::text)) returning id,cursor`,
      [
        row.account_id,
        row.id,
        row.todo_id,
        row.occurrence_key,
        row.content,
        row.triggered_at.toISOString(),
      ],
    );
    const payload = {
      type: "TODO_TRIGGERED",
      eventId: row.id,
      inboxId: inbox.rows[0]!.id,
      cursor: Number(inbox.rows[0]!.cursor),
      todoId: row.todo_id,
      occurrenceKey: row.occurrence_key,
      content: row.content,
      triggeredAt: row.triggered_at.toISOString(),
    };
    await query(
      `insert into notification_outbox(trigger_event_id,device_id,event_id,payload)
       select $1,d.id,$1,$2::jsonb from devices d where d.account_id=$3 and d.active
       on conflict(trigger_event_id,device_id) do nothing`,
      [row.id, JSON.stringify(payload), row.account_id],
    );
    await query(
      `update todo_occurrences set status='TRIGGERED',triggered_at=$2 where id=$1`,
      [input.occurrenceId, row.triggered_at],
    );
    await query(
      `update todos set last_triggered_at=$2,next_occurrence_at=null,
       active=case when recurrence_type='ONCE' then false else active end,
       lifecycle_status=case when recurrence_type='ONCE' then 'TRIGGERED' else lifecycle_status end,
       version=version+1,updated_at=now() where id=$1`,
      [row.todo_id, row.triggered_at],
    );
    return { emitted: true, eventId: row.id };
  }
}
