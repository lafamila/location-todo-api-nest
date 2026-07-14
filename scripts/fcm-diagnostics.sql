select
  platform,
  active,
  push_token is not null as push_token_registered,
  push_token_updated_at,
  last_seen_at
from devices
order by last_seen_at desc
limit 50;

select
  o.created_at,
  o.event_id,
  d.platform,
  o.status,
  o.attempt_count,
  o.next_attempt_at,
  o.sent_at,
  latest.outcome,
  latest.provider_status,
  latest.error_code,
  left(o.last_error, 300) as last_error
from notification_outbox o
join devices d on d.id = o.device_id
left join lateral (
  select outcome, provider_status, error_code
  from delivery_attempts
  where outbox_id = o.id
  order by attempt_number desc
  limit 1
) latest on true
order by o.created_at desc
limit 100;
