CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT 'local-user',
  -- threads 在 005 创建，外键也在 005 补，避免迁移顺序耦合。
  thread_id uuid,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('user_note', 'screenshot', 'web_page', 'action_receipt')),
  content text,
  storage_path text,
  mime_type text,
  sha256 text,
  source_summary text,
  metadata jsonb NOT NULL DEFAULT '{}',
  captured_at timestamptz NOT NULL DEFAULT now(),
  -- 只有截图需要短期过期；到期后删原图、保留摘要与来源关系。
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT evidence_screenshot_expiry_check CHECK (
    type <> 'screenshot' OR expires_at IS NOT NULL
  )
);

CREATE INDEX evidence_contact_captured_idx ON evidence (contact_id, captured_at DESC);
CREATE INDEX evidence_expires_idx ON evidence (expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX evidence_sha256_idx ON evidence (sha256) WHERE sha256 IS NOT NULL;
