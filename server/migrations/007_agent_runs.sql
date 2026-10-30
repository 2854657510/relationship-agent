CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  -- 客户端生成的请求幂等键；同一 thread 重复发送只产生一个 run。
  request_id text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN (
    'running',
    'waiting_questionnaire',
    'waiting_permission',
    'completed',
    'proposed',
    'failed',
    'aborted'
  )),
  model text NOT NULL,
  prompt_version text,
  permission_mode text NOT NULL DEFAULT 'ask' CHECK (permission_mode IN ('ask', 'full')),
  page_context jsonb NOT NULL DEFAULT '{}',
  budget jsonb NOT NULL DEFAULT '{}',
  usage jsonb NOT NULL DEFAULT '{}',
  -- 问卷/联网授权恢复时，如果是新建 run，就记录从哪次 run 续上。
  resumed_from_run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,

  UNIQUE (thread_id, request_id)
);

CREATE INDEX agent_runs_thread_started_idx ON agent_runs (thread_id, started_at DESC);
CREATE INDEX agent_runs_status_idx ON agent_runs (status);
