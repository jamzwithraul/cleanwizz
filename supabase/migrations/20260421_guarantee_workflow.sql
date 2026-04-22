-- Sprint I: 200% Satisfaction Guarantee Enforcement
-- Migration: guarantee_workflow
-- Applied before the feat/guarantee-enforcement branches are merged.

-- ── reclean_requests ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS reclean_requests (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                     uuid NOT NULL REFERENCES jobs(id),
  client_email               text NOT NULL,
  description                text NOT NULL,
  photos_urls                text[] DEFAULT '{}',
  status                     text NOT NULL DEFAULT 'pending',
  -- valid values: pending | approved | dispatched | completed | denied
  admin_notes                text,
  dispatched_to_contractor_id uuid REFERENCES contractor_applications(id),
  dispatched_at              timestamptz,
  completed_at               timestamptz,
  denied_reason              text,
  denied_at                  timestamptz,
  sla_breached               boolean DEFAULT false,
  requested_at               timestamptz DEFAULT now(),
  created_at                 timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reclean_status ON reclean_requests(status);
CREATE INDEX IF NOT EXISTS idx_reclean_job    ON reclean_requests(job_id);

-- ── refunds ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refunds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES jobs(id),
  amount_cents      int NOT NULL,
  stripe_refund_id  text,
  reason            text NOT NULL,
  issued_by_user_id uuid,
  issued_at         timestamptz DEFAULT now()
);

-- ── contractors: reclean clause version ──────────────────────────────────────
-- version 0 = original agreement (no reclean clause)
-- version 1 = includes Section X — Quality Guarantee Recleans
ALTER TABLE contractor_applications
  ADD COLUMN IF NOT EXISTS signwell_reclean_clause_version int DEFAULT 0;
