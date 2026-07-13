create extension if not exists pgcrypto;

create table accounts (
  id uuid primary key,
  email text,
  display_name text not null,
  permission text not null check (permission in ('visitor', 'user', 'superadmin')),
  permission_schema_version integer,
  upgrade_status text check (upgrade_status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  installation_id text not null,
  platform text not null check (platform in ('ios', 'android', 'macos', 'windows', 'web')),
  app_version text not null,
  push_token text,
  push_token_updated_at timestamptz,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique(account_id, installation_id)
);
create unique index devices_push_token_active_idx on devices(push_token) where active and push_token is not null;

create table app_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  device_id uuid references devices(id) on delete cascade,
  token_hash text not null unique,
  csrf_hash text,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  access_token_expires_at timestamptz not null,
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table login_transactions (
  id uuid primary key default gen_random_uuid(),
  state_hash text not null unique,
  verifier_encrypted text not null,
  return_uri text,
  client_kind text not null check (client_kind in ('web', 'native')),
  installation_id text,
  platform text check (platform in ('ios', 'android', 'macos', 'windows', 'web')),
  app_version text,
  status text not null default 'pending' check (status in ('pending', 'completed', 'failed', 'consumed')),
  session_id uuid references app_sessions(id) on delete set null,
  one_time_session_encrypted text,
  error_code text,
  error_message text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table saved_geofences (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  name varchar(100) not null,
  address varchar(300) not null,
  place_metadata jsonb,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  radius_meters integer not null check (radius_meters between 100 and 5000),
  version integer not null default 1,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index saved_geofences_account_active_idx on saved_geofences(account_id) where deleted_at is null;

create table todos (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  content varchar(500) not null,
  kind text not null check (kind in ('LOCATION', 'TIME')),
  timezone text not null,
  recurrence_type text not null check (recurrence_type in ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY')),
  recurrence_start_date date not null,
  recurrence_weekdays smallint[] not null default '{}',
  recurrence_month_days smallint[] not null default '{}',
  local_time time,
  trigger_type text check (trigger_type in ('ENTRY_IMMEDIATE', 'ENTRY_DELAYED', 'DWELL')),
  trigger_minutes integer check (trigger_minutes between 1 and 1440),
  active boolean not null default true,
  lifecycle_status text not null default 'ACTIVE' check (lifecycle_status in ('ACTIVE', 'INACTIVE', 'TRIGGERED', 'COMPLETED')),
  activation_generation integer not null default 1,
  next_occurrence_at timestamptz,
  last_triggered_at timestamptz,
  completed_at timestamptz,
  deleted_at timestamptz,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((kind = 'TIME' and local_time is not null and trigger_type is null) or
         (kind = 'LOCATION' and local_time is null and trigger_type is not null)),
  check ((trigger_type in ('ENTRY_DELAYED', 'DWELL') and trigger_minutes is not null) or
         (trigger_type is distinct from 'ENTRY_DELAYED' and trigger_type is distinct from 'DWELL' and trigger_minutes is null))
);
create index todos_account_active_idx on todos(account_id, kind) where deleted_at is null;

create table todo_schedule_windows (
  id uuid primary key default gen_random_uuid(),
  todo_id uuid not null references todos(id) on delete cascade,
  local_date date,
  start_time time not null,
  end_minute integer not null check (end_minute between 1 and 1440),
  check (extract(hour from start_time) * 60 + extract(minute from start_time) < end_minute)
);

create table todo_geofences (
  todo_id uuid not null references todos(id) on delete cascade,
  geofence_id uuid not null references saved_geofences(id),
  primary key(todo_id, geofence_id)
);

create table todo_occurrences (
  id uuid primary key default gen_random_uuid(),
  todo_id uuid not null references todos(id) on delete cascade,
  occurrence_key text not null,
  due_at timestamptz,
  status text not null default 'PENDING' check (status in ('PENDING', 'TRIGGERED', 'CANCELLED')),
  triggered_at timestamptz,
  created_at timestamptz not null default now(),
  unique(todo_id, occurrence_key)
);

create table due_jobs (
  id uuid primary key default gen_random_uuid(),
  occurrence_id uuid not null references todo_occurrences(id) on delete cascade,
  kind text not null check (kind in ('TIME', 'DELAYED', 'DWELL')),
  due_at timestamptz not null,
  device_id uuid references devices(id) on delete cascade,
  geofence_id uuid references saved_geofences(id) on delete cascade,
  status text not null default 'PENDING' check (status in ('PENDING', 'RUNNING', 'DONE', 'CANCELLED')),
  attempts integer not null default 0,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create unique index due_jobs_time_unique on due_jobs(occurrence_id, kind) where kind in ('TIME', 'DELAYED');
create unique index due_jobs_dwell_unique on due_jobs(occurrence_id, kind, device_id, geofence_id) where kind = 'DWELL';
create index due_jobs_ready_idx on due_jobs(due_at) where status = 'PENDING';

create table device_geofence_states (
  todo_id uuid not null references todos(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  geofence_id uuid not null references saved_geofences(id) on delete cascade,
  activation_generation integer not null,
  state text not null check (state in ('unknown', 'inside', 'outside')),
  armed boolean not null default false,
  entered_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(todo_id, device_id, geofence_id)
);

create table transition_events (
  id uuid primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  device_sequence bigint not null,
  geofence_id uuid not null references saved_geofences(id) on delete cascade,
  transition text not null check (transition in ('ENTER', 'EXIT')),
  observed_at timestamptz not null,
  accuracy_meters double precision check (accuracy_meters is null or accuracy_meters between 0 and 5000),
  disposition text not null,
  received_at timestamptz not null default now(),
  unique(device_id, device_sequence)
);

create table todo_trigger_guards (
  occurrence_id uuid primary key references todo_occurrences(id) on delete cascade,
  source_type text not null,
  source_id uuid,
  created_at timestamptz not null default now()
);

create table trigger_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  todo_id uuid not null references todos(id) on delete cascade,
  occurrence_id uuid not null unique references todo_occurrences(id) on delete cascade,
  occurrence_key text not null,
  content text not null,
  source_type text not null,
  triggered_at timestamptz not null default now()
);

create table notification_inbox (
  cursor bigserial primary key,
  id uuid not null unique default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  trigger_event_id uuid not null references trigger_events(id) on delete cascade,
  payload jsonb not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);
create index notification_inbox_account_cursor_idx on notification_inbox(account_id, cursor);

create table notification_outbox (
  id uuid primary key default gen_random_uuid(),
  trigger_event_id uuid not null references trigger_events(id) on delete cascade,
  device_id uuid not null references devices(id) on delete cascade,
  event_id uuid not null,
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'SENDING', 'SENT', 'FAILED')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(trigger_event_id, device_id)
);
create index notification_outbox_ready_idx on notification_outbox(next_attempt_at) where status = 'PENDING';

create table delivery_attempts (
  id bigserial primary key,
  outbox_id uuid not null references notification_outbox(id) on delete cascade,
  attempt_number integer not null,
  outcome text not null,
  provider_status integer,
  error_code text,
  created_at timestamptz not null default now(),
  unique(outbox_id, attempt_number)
);

create table map_handoffs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  session_id uuid not null references app_sessions(id) on delete cascade,
  allowed_origin text not null,
  request_payload jsonb not null default '{}',
  result_payload jsonb,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
