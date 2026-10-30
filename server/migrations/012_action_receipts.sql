CREATE TABLE action_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 一个 Action 最多一个回执；重复 confirm 靠这个唯一约束兜底。
  action_id uuid NOT NULL UNIQUE REFERENCES actions(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('success', 'failed')),
  actual_result jsonb NOT NULL DEFAULT '{}',
  error text,
  receipt_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX action_receipts_status_idx ON action_receipts (status);
