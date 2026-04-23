-- ============================================================
-- Clean Wizz — subscription_billing_errors
-- Stores per-sweep failures so the operator can triage
-- without losing visibility into which subscriptions failed
-- and why. resolved_at is set manually once the operator
-- has fixed the root cause (e.g. updated payment method).
-- ============================================================

create table if not exists subscription_billing_errors (
  id               uuid        primary key default gen_random_uuid(),
  subscription_id  uuid        not null references subscriptions(id) on delete cascade,
  error_message    text        not null,
  stripe_error_code text,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);

create index if not exists sbe_subscription_id_idx  on subscription_billing_errors(subscription_id);
create index if not exists sbe_created_at_idx       on subscription_billing_errors(created_at desc);
create index if not exists sbe_resolved_at_idx      on subscription_billing_errors(resolved_at)
  where resolved_at is null;

-- RLS: service-role backend only; no anon access
alter table subscription_billing_errors enable row level security;
