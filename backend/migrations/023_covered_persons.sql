-- Covered persons: clear list of individuals the backend tracks for
-- monthly report delivery.  Each row represents one person on a
-- client's plan that is currently enabled and has had their initial
-- fee deducted.  The reports-watcher uses this table (not the
-- encrypted people-list blob) to decide who needs a monthly report.

CREATE TABLE covered_persons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- The SeatMember.id from the client's people-list blob, used to
  -- correlate encrypted-blob edits with this tracking row.
  person_id UUID NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  enabled BOOLEAN NOT NULL DEFAULT true,
  -- Timestamp of the initial activation (first time fee was deducted).
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Null until the sample/initial report has been sent.
  initial_report_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(client_id, person_id)
);

CREATE INDEX idx_covered_persons_client ON covered_persons(client_id);
CREATE INDEX idx_covered_persons_active ON covered_persons(client_id, enabled)
  WHERE enabled = true;
