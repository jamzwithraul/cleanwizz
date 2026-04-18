-- ============================================================
-- Clean Wizz — Supabase PostgreSQL Schema
-- Run this in your Supabase SQL Editor (or via supabase db push)
-- ============================================================

-- Enable UUID generation
create extension if not exists "pgcrypto";

-- ── clients ──────────────────────────────────────────────────
create table if not exists clients (
  id          text primary key default gen_random_uuid()::text,
  name        text not null,
  email       text not null,
  phone       text not null default '',
  address     text not null default '',
  created_at  timestamptz not null default now()
);

-- ── quotes ───────────────────────────────────────────────────
create table if not exists quotes (
  id              text primary key default gen_random_uuid()::text,
  client_id       text not null references clients(id) on delete cascade,
  subtotal        numeric(10,2) not null,
  discount        numeric(10,2) not null default 0,
  total           numeric(10,2) not null,
  currency        text not null default 'CAD',
  promo_code      text,
  expires_at      timestamptz not null,
  status          text not null default 'draft'
                    check (status in ('draft','sent','accepted','expired')),
  created_at      timestamptz not null default now(),
  property_type   text not null default '',
  square_footage  numeric(10,2) not null default 0,
  bedrooms        integer not null default 0,
  bathrooms       integer not null default 0,
  special_notes   text not null default '',
  services        text not null default '[]',  -- JSON array stored as text
  addons          text not null default '[]'   -- JSON array stored as text
);

create index if not exists quotes_client_id_idx on quotes(client_id);
create index if not exists quotes_status_idx    on quotes(status);
create index if not exists quotes_created_at_idx on quotes(created_at desc);

-- ── quote_items ───────────────────────────────────────────────
create table if not exists quote_items (
  id          text primary key default gen_random_uuid()::text,
  quote_id    text not null references quotes(id) on delete cascade,
  label       text not null,
  quantity    numeric(10,4) not null default 1,
  unit_price  numeric(10,2) not null,
  line_total  numeric(10,2) not null
);

create index if not exists quote_items_quote_id_idx on quote_items(quote_id);

-- ── promo_codes ───────────────────────────────────────────────
create table if not exists promo_codes (
  id          text primary key default gen_random_uuid()::text,
  code        text not null unique,
  type        text not null check (type in ('percent','fixed')),
  value       numeric(10,2) not null,
  active      boolean not null default true,
  valid_from  timestamptz,
  valid_to    timestamptz
);

-- ── settings (single-row) ─────────────────────────────────────
create table if not exists settings (
  id                    text primary key default 'default',
  price_per_sqft        numeric(10,4) not null default 0.12,
  base_rate             numeric(10,2) not null default 80,
  fridge_price          numeric(10,2) not null default 20,
  oven_price            numeric(10,2) not null default 25,
  windows_price         numeric(10,2) not null default 40,
  baseboards_price      numeric(10,2) not null default 30,
  deep_clean_surcharge  numeric(10,2) not null default 60,
  moveout_surcharge     numeric(10,2) not null default 100,
  updated_at            timestamptz not null default now()
);

-- ── email_signups ─────────────────────────────────────────────
-- CASL / PIPEDA consent audit log for email-gated discounts.
-- Append-only: multiple rows per email allowed (one per consent event).
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

create index if not exists email_signups_email_idx       on email_signups(email);
create index if not exists email_signups_consent_at_idx  on email_signups(consent_at desc);
create index if not exists email_signups_booking_id_idx  on email_signups(booking_id);

-- ── Row Level Security ────────────────────────────────────────
-- The backend uses the SERVICE ROLE key, so RLS is bypassed for
-- all server-side calls.  Enable RLS anyway so anon/public keys
-- cannot read data if accidentally exposed.
alter table clients       enable row level security;
alter table quotes        enable row level security;
alter table quote_items   enable row level security;
alter table promo_codes   enable row level security;
alter table settings      enable row level security;
alter table email_signups enable row level security;

-- Service-role always bypasses RLS; no explicit policy needed.
-- If you ever want authenticated users to query their own data,
-- add policies here.

-- ── Seed default data ─────────────────────────────────────────
insert into settings (id, updated_at) values ('default', now())
  on conflict (id) do nothing;

insert into promo_codes (code, type, value) values
  ('SAVE10', 'percent', 10),
  ('FLAT25', 'fixed',   25)
  on conflict (code) do nothing;
