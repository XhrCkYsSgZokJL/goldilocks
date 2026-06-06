-- Screening events: an append-only log of every time a person is
-- activated or renewed. A "screening" happens when a person is first
-- activated (or re-activated) on a client's plan, and again each month
-- when the balance tick renews their coverage. The admin Stats dashboard
-- reads this to chart cumulative screenings over time; nothing in the
-- billing path depends on it, so writes are best-effort.

CREATE TABLE screening_events (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  client_id   UUID        NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  -- The SeatMember.id (covered_persons.person_id). Nullable so a write
  -- can never fail billing if the person id is somehow unavailable.
  person_id   UUID,
  -- 'activation' | 'renewal'.
  kind        TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_screening_events_occurred ON screening_events(occurred_at);
CREATE INDEX idx_screening_events_client ON screening_events(client_id);
