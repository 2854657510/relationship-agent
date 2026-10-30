CREATE TABLE questionnaires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  questions jsonb NOT NULL,
  answers jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'answered', 'cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE INDEX questionnaires_run_idx ON questionnaires (run_id);
CREATE INDEX questionnaires_thread_status_idx ON questionnaires (thread_id, status);

CREATE TABLE permission_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'granted', 'denied')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE INDEX permission_requests_run_idx ON permission_requests (run_id);
CREATE INDEX permission_requests_status_idx ON permission_requests (status);
