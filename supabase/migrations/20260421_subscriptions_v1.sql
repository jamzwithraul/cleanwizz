-- ============================================================
-- Clean Wizz — subscriptions v1
-- Bi-weekly recurring service model.  Billing is per-visit
-- (off-session Stripe PaymentIntent), NOT a true Stripe Subscription.
-- Seat cap: 15 active subscribers (enforced at application layer).
-- ============================================================

create extension if not exists "pgcrypto";

-- ── subscriptions ──────────────────────────────────────────────────────────────
create table if not exists subscriptions (
  id                       uuid        primary key default gen_random_uuid(),

  -- Customer info (denormalised for speed; no account required at v1)
  customer_email           text        not null,
  customer_name            text        not null,
  customer_phone           text,
  service_address          text        not null,

  -- Service parameters
  service_type             text        not null
                             check (service_type in ('standard','deep','moveout','micro')),
  sqft                     int         not null check (sqft > 0),
  frequency                text        not null default 'biweekly'
                             check (frequency = 'biweekly'),   -- only option in v1

  -- Lifecycle
  status                   text        not null default 'active'
                             check (status in ('active','paused','cancelled','waitlisted')),
  cancelled_at             timestamptz,
  paused_until             timestamptz,
  next_visit_at            timestamptz,

  -- Billing
  stripe_customer_id       text,
  stripe_payment_method_id text,
  discount_pct             numeric(5,2) not null default 15.00,
  founders_lock            boolean     not null default true,
  -- Base price at signup (pre-discount, in cents).  Locked for life.
  locked_base_price_cents  int         not null,

  created_at               timestamptz not null default now()
);

-- Indexes
create index if not exists subscriptions_status_idx        on subscriptions(status);
create index if not exists subscriptions_customer_email_idx on subscriptions(customer_email);
create index if not exists subscriptions_next_visit_at_idx  on subscriptions(next_visit_at);

-- RLS: service-role backend only; no anon access
alter table subscriptions enable row level security;

-- ── jobs.subscription_id FK ────────────────────────────────────────────────────
-- Nullable: existing one-time jobs are unaffected.
alter table jobs
  add column if not exists subscription_id uuid references subscriptions(id) on delete set null;

create index if not exists jobs_subscription_id_idx on jobs(subscription_id);
