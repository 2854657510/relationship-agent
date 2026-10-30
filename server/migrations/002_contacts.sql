CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL DEFAULT 'local-user',
  display_name text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged')),
  merged_into_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  merged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  -- merged 必须指向 target；active 不能带合并字段。避免出现“半合并”状态。
  CONSTRAINT contacts_merged_fields_check CHECK (
    (status = 'active' AND merged_into_id IS NULL AND merged_at IS NULL)
    OR (status = 'merged' AND merged_into_id IS NOT NULL AND merged_at IS NOT NULL)
  ),
  CONSTRAINT contacts_not_self_merged CHECK (merged_into_id IS NULL OR merged_into_id <> id)
);

CREATE INDEX contacts_user_status_idx ON contacts (user_id, status);
CREATE INDEX contacts_display_name_idx ON contacts (lower(display_name));
