alter table login_transactions
  drop constraint login_transactions_status_check;
alter table login_transactions
  add constraint login_transactions_status_check
  check (status in ('pending', 'processing', 'completed', 'failed', 'consumed'));

alter table app_sessions
  add column client_platform text;
update app_sessions set client_platform='web';
update app_sessions s
set client_platform=d.platform
from devices d
where d.id=s.device_id;
alter table app_sessions
  alter column client_platform set not null,
  add constraint app_sessions_client_platform_check
  check (client_platform in ('ios','android','macos','windows','web'));

alter table todos
  add column activated_at timestamptz not null default now();

create table rate_limit_counters (
  scope text not null,
  subject text not null,
  window_start timestamptz not null,
  count integer not null check (count > 0),
  primary key(scope,subject,window_start)
);
