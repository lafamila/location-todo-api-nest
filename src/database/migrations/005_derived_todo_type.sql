drop index todos_account_active_idx;

update todo_occurrences o
set due_at = o.occurrence_key::timestamp at time zone 'Asia/Seoul'
from todos t
where t.id=o.todo_id
  and t.kind='TIME'
  and o.status='PENDING'
  and o.occurrence_key ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$';

update due_jobs j
set due_at=o.due_at
from todo_occurrences o, todos t
where o.id=j.occurrence_id
  and t.id=o.todo_id
  and t.kind='TIME'
  and j.kind='TIME'
  and j.status='PENDING'
  and o.due_at is not null;

update todos t
set next_occurrence_at=(
  select min(o.due_at)
  from todo_occurrences o
  where o.todo_id=t.id and o.status='PENDING'
)
where t.kind='TIME';

alter table todos
  drop constraint todos_kind_check,
  drop constraint todos_check,
  drop column kind,
  drop column timezone,
  add constraint todos_time_or_location_fields_check
  check (
    (local_time is not null and trigger_type is null) or
    (local_time is null and trigger_type is not null)
  );

create index todos_account_active_idx
  on todos(account_id)
  where deleted_at is null;
