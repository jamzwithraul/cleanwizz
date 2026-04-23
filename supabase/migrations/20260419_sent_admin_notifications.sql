-- ============================================================
-- Clean Wizz — sent_admin_notifications
-- Idempotency ledger for admin email notifications. Used today
-- only to dedupe contractor-signup webhooks (Supabase Auth may
-- retry on transient failure). Booking events are NOT deduped
-- here — repeat bookings are legitimate and each deserves a row.
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists sent_admin_notifications (
  id          uuid primary key default gen_random_uuid(),
  event_type  text not null,
  event_key   text not null,
  sent_at     timestamptz not null default now()
);

-- Unique only for contractor_signup: one email per auth user.
-- Booking events can repeat (same email may book many times), so we
-- scope the uniqueness to the contractor flow via a partial index.
create unique index if not exists sent_admin_notifications_contractor_uq
  on sent_admin_notifications (event_key)
  where event_type = 'contractor_signup';

create index if not exists sent_admin_notifications_event_type_idx
  on sent_admin_notifications (event_type, sent_at desc);

alter table sent_admin_notifications enable row level security;
-- No policies: service-role backend bypasses RLS. Anon must not read.
