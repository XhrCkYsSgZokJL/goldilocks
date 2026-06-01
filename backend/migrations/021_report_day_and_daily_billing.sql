-- Migration 021: report delivery day + daily balance tick.
--
-- Switches from the continuous-drain prepaid model (settle on each API
-- call) to a daily $2/person deduction:
--
--   * `report_day` on clients: '1st' or '14th' — when the client's
--     reports are batched and delivered each month.
--   * `covered_people` on clients: how many people currently have active
--     coverage (reports delivered, live events running). This is the
--     count the daily tick multiplies by the daily rate.
--   * `last_balance_tick_at` on clients: when the daily cron last
--     deducted from this client's balance. Null until the first tick.
--
-- The old `billing_seats` column is kept for now — it still represents
-- the number of people on the plan. `covered_people` is the subset
-- whose reports have actually been delivered (coverage started).

ALTER TABLE clients ADD COLUMN IF NOT EXISTS report_day TEXT NOT NULL DEFAULT '1st';
ALTER TABLE clients ADD COLUMN IF NOT EXISTS covered_people INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS last_balance_tick_at TIMESTAMPTZ;
