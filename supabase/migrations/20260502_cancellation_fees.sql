-- ============================================================
-- Migration: cancellation_fees
-- Adds cancellation tracking columns to jobs and subscriptions.
-- Sprint H — scaffolding only; Stripe auto-charge is a follow-up sprint.
-- ============================================================

-- ── jobs table additions ──────────────────────────────────────────────────────
-- cancelled_at:                 when the cancellation was recorded by admin
-- cancellation_reason:          free-text reason supplied by admin
-- cancellation_fee_cents:       computed fee (0 / 50% / 100% of job total)
-- cancellation_fee_charged_at:  set when the fee is actually collected via Stripe
--                               (NULL until the follow-up Stripe auto-charge sprint)

alter table jobs
  add column if not exists cancelled_at               timestamptz,
  add column if not exists cancellation_reason        text,
  add column if not exists cancellation_fee_cents     int  not null default 0,
  add column if not exists cancellation_fee_charged_at timestamptz;

-- ── subscriptions table additions ────────────────────────────────────────────
-- skipped_visits_late: running counter of skips made with less than 48 hours
--                      notice; used for pattern detection / admin review.

alter table subscriptions
  add column if not exists skipped_visits_late int not null default 0;
