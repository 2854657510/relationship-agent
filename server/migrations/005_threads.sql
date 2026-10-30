CREATE TABLE threads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT 'local-user',
  title text,
  compaction_summary text,
  -- CAS：防止两个并发压缩用旧摘要覆盖新摘要。
  compaction_version integer NOT NULL DEFAULT 0 CHECK (compaction_version >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX threads_user_updated_idx ON threads (user_id, updated_at DESC);

ALTER TABLE evidence
  ADD CONSTRAINT evidence_thread_id_fkey
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE SET NULL;
