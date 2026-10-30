CREATE TABLE memory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind text NOT NULL,
  content text NOT NULL,
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'confirmed', 'rejected', 'superseded')),
  confidence text NOT NULL DEFAULT 'medium'
    CHECK (confidence IN ('low', 'medium', 'high')),
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  -- Insight 附带的 memoryDraft 落在这里，并由 source_insight_id 指回洞察。
  source_insight_id uuid REFERENCES insights(id) ON DELETE SET NULL,
  superseded_by uuid REFERENCES memory_items(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz
);

CREATE INDEX memory_items_contact_status_idx ON memory_items (contact_id, status);
CREATE INDEX memory_items_source_insight_idx ON memory_items (source_insight_id);
