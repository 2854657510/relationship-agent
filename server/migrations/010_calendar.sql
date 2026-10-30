CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT 'local-user',
  title text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  location text,
  notes text,
  contact_ids uuid[] NOT NULL DEFAULT '{}',
  -- 乐观锁：Action 从提案到确认期间，用户可能已经改过事件。
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT calendar_events_time_check CHECK (ends_at > starts_at)
);

CREATE INDEX calendar_events_user_start_idx ON calendar_events (user_id, starts_at);

CREATE TABLE meet_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  intent text NOT NULL,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'confirmed', 'rejected', 'archived')),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meet_intents_contact_status_idx ON meet_intents (contact_id, status);
