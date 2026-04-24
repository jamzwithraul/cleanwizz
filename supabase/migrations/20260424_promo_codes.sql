-- 2026-04-24 — create promo_codes table + seed WELCOME15.
--
-- The application code (server/storage.supabase.ts:getPromoCode) has been
-- querying public.promo_codes for months but the table was never created.
-- When a client entered any promo code (e.g. WELCOME15 on the booking form),
-- the Supabase query threw "relation promo_codes does not exist" and the
-- entire booking endpoint returned 500.
--
-- This migration creates the table with the columns the application expects
-- (matching the shape inferred from server/storage.supabase.ts) and seeds
-- WELCOME15 (15% off) so the marketed promo actually works.

create table if not exists public.promo_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  type         text not null check (type in ('percent','fixed')),
  value        numeric(10,2) not null,
  active       boolean not null default true,
  valid_from   timestamptz,
  valid_to     timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists promo_codes_code_upper_idx on public.promo_codes (upper(code));
create index if not exists promo_codes_active_idx     on public.promo_codes (active) where active = true;

insert into public.promo_codes (code, type, value, active)
values ('WELCOME15', 'percent', 15, true)
on conflict (code) do nothing;
