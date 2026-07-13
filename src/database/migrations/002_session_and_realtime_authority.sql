alter table login_transactions
  add column browser_nonce_hash text;

alter table notification_outbox
  add column realtime_delivered_at timestamptz;
