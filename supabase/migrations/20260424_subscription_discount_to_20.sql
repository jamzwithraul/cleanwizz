-- 2026-04-24 — bump subscription discount from 15% to 20%.
--
-- Rationale: multi-booking discount (20% for 2+ one-off sessions) was removed
-- from the booking UI. To keep the value ladder coherent (recurring commitment
-- earns the biggest discount), bi-weekly subscriptions now get 20% off every
-- visit instead of 15%. The backend insert sites already pass 20.00 for new
-- subscriptions; this migration just updates the column default so any direct
-- inserts (admin tools, seeds, tests) pick up the right default.
--
-- Existing active subscriptions are NOT migrated by this script. To retroactively
-- promote current subscribers to 20%, run:
--   update subscriptions set discount_pct = 20.00 where status in ('active','paused');

alter table subscriptions
  alter column discount_pct set default 20.00;
