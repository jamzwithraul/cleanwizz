-- ============================================================
-- Clean Wizz — email_signups audit table
-- CASL / PIPEDA consent capture for email-gated discounts.
-- Append-only; multiple rows per email are expected (one per
-- consent event) so we keep a full audit trail.
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists email_signups (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  source        text not null check (source in ('inline_checkbox', 'promo_popup')),
  consent_text  text not null,
  consent_at    timestamptz not null default now(),
  ip_address    text,
  user_agent    text,
  booking_id    text references quotes(id) on delete set null
);

-- Lowercase emails at write time (enforce via trigger for safety).
create or replace function email_signups_lowercase_email()
returns trigger language plpgsql as $$
begin
  new.email := lower(new.email);
  return new;
end;
$$;

drop trigger if exists trg_email_signups_lowercase on email_signups;
create trigger trg_email_signups_lowercase
  before insert or update on email_signups
  for each row execute function email_signups_lowercase_email();

create index if not exists email_signups_email_idx       on email_signups(email);
create index if not exists email_signups_consent_at_idx  on email_signups(consent_at desc);
create index if not exists email_signups_booking_id_idx  on email_signups(booking_id);

-- Service-role backend bypasses RLS; enable it so anon keys cannot
-- read the audit log if accidentally exposed.
alter table email_signups enable row level security;
