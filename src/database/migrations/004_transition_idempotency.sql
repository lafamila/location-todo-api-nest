alter table devices
  add column last_transition_sequence bigint not null default -1;

create table transition_idempotency_keys (
  event_id uuid primary key,
  device_id uuid not null references devices(id) on delete cascade,
  device_sequence bigint not null,
  geofence_id uuid not null,
  transition text not null check (transition in ('ENTER','EXIT')),
  observed_at timestamptz not null,
  accuracy_meters double precision,
  disposition text not null,
  created_at timestamptz not null default now(),
  unique(device_id,device_sequence)
);

alter table transition_events
  drop constraint transition_events_geofence_id_fkey;

insert into transition_idempotency_keys
  (event_id,device_id,device_sequence,geofence_id,transition,observed_at,accuracy_meters,disposition,created_at)
select id,device_id,device_sequence,geofence_id,transition,observed_at,accuracy_meters,disposition,received_at
from transition_events;

update devices d
set last_transition_sequence=coalesce((
  select max(k.device_sequence) from transition_idempotency_keys k where k.device_id=d.id
),-1);
