-- ─────────────────────────────────────────────────────────────────────────────
-- Team assignments + Large Home Add-On (Phase 2 pricing overhaul)
-- Supabase project: gjfeqnfmwbsfwnbepwvu
--
-- Adds the columns needed to:
--   1. Track 2- and 3-contractor team jobs on the `jobs` table.
--   2. Record the Large Home Add-On applied to a booking.
--   3. Record per-contractor onboarding acknowledgements on
--      `contractor_applications` for the new team-work / stranger-pairing
--      agreement checkboxes.
--
-- Existing contractors are intentionally left with NULL acknowledgement
-- timestamps (grandfathered). New signups will be required to accept at
-- onboarding time.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── jobs: team assignments + large-home add-on ──────────────────────────────
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS assigned_contractor_count INT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS large_home_addon_cents INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS second_contractor_id UUID REFERENCES contractor_applications(id),
  ADD COLUMN IF NOT EXISTS third_contractor_id  UUID REFERENCES contractor_applications(id),
  ADD COLUMN IF NOT EXISTS second_contractor_arrived_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS second_contractor_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS third_contractor_arrived_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS third_contractor_completed_at  TIMESTAMPTZ;

-- Useful for admin queries that filter team jobs.
CREATE INDEX IF NOT EXISTS idx_jobs_assigned_contractor_count
  ON jobs(assigned_contractor_count);

-- ── contractor_applications: team-work acknowledgements ─────────────────────
-- (The `contractors` table referenced in the spec maps to
-- `contractor_applications` in this Supabase project — that's the only
-- existing contractor table in the live DB.)
ALTER TABLE contractor_applications
  ADD COLUMN IF NOT EXISTS team_work_acknowledged_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stranger_pairing_acknowledged_at TIMESTAMPTZ;
