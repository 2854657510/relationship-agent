import { useState } from "react";
import type { ActionView } from "../api.ts";

export interface ActionConfirmResult {
  actionId: string;
  status: string;
  receipt: {
    id: string;
    status: string;
    actual_result: unknown;
    error: string | null;
  };
  insight: Array<{ status: string; error?: string }>;
}

interface ActionCardProps {
  action: ActionView;
  busy: boolean;
  result: ActionConfirmResult | null;
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
}

function field(label: string, value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="kv" key={label}>
      <span>{label}</span>
      <strong>{String(value)}</strong>
    </div>
  );
}

export function ActionCard({ action, busy, result, onConfirm, onReject }: ActionCardProps) {
  const [showRaw, setShowRaw] = useState(false);
  const payload = action.payload as Record<string, unknown>;
  const patch = (payload.patch ?? {}) as Record<string, unknown>;

  return (
    <section className="panel action-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Action Card</p>
          <h3>{action.type}</h3>
        </div>
        <span className="badge warn">待确认</span>
      </div>

      <div className="kv-list">
        {field("联系人 ID", payload.contactId ?? payload.targetContactId ?? action.payload.contactId)}
        {field("姓名", payload.displayName)}
        {field("标题", payload.title)}
        {field("开始", payload.startsAt)}
        {field("结束", payload.endsAt)}
        {field("时区", payload.timezone)}
        {field("地点", payload.location)}
        {field("事件 ID", payload.eventId)}
        {Object.entries(patch).map(([key, value]) => field(key, value))}
        {field("baseVersion", action.base_version)}
      </div>

      {action.rationale && <p className="rationale">{action.rationale}</p>}

      {action.evidence_ids.length > 0 && (
        <div className="evidence-row">
          <span className="muted">证据：</span>
          {action.evidence_ids.map((id) => (
            <code key={id}>{id.slice(0, 8)}</code>
          ))}
        </div>
      )}

      <button type="button" className="link-button" onClick={() => setShowRaw((value) => !value)}>
        {showRaw ? "收起原始 payload" : "查看原始 payload"}
      </button>
      {showRaw && <pre className="raw">{JSON.stringify(action.payload, null, 2)}</pre>}

      {!result && (
        <div className="button-row">
          <button type="button" className="primary" disabled={busy} onClick={() => void onConfirm()}>
            确认执行
          </button>
          <button type="button" className="danger" disabled={busy} onClick={() => void onReject()}>
            拒绝
          </button>
        </div>
      )}

      {result && (
        <div className={`receipt ${result.receipt.status}`}>
          <p>
            回执：<strong>{result.receipt.status}</strong>
            {result.receipt.error ? `（${result.receipt.error}）` : ""}
          </p>
          <pre className="raw">{JSON.stringify(result.receipt.actual_result, null, 2)}</pre>
          <p className="muted">
            Insight：
            {result.insight.length
              ? result.insight.map((item) => `${item.status}${item.error ? `(${item.error})` : ""}`).join("、")
              : "未触发"}
          </p>
        </div>
      )}
    </section>
  );
}
