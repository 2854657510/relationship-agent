import type { PermissionView } from "../api.ts";

interface PermissionCardProps {
  permission: PermissionView;
  busy: boolean;
  onDecide: (decision: "granted" | "denied") => Promise<void>;
}

export function PermissionCard({ permission, busy, onDecide }: PermissionCardProps) {
  const args = permission.args ?? {};
  const url = typeof args.url === "string" ? args.url : null;

  return (
    <section className="panel permission-card">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Permission</p>
          <h3>本次联网授权</h3>
        </div>
        <span className="badge warn">待确认</span>
      </div>
      <p>
        工具：<code>{permission.tool_name}</code>
      </p>
      {url && (
        <p>
          地址：<code>{url}</code>
        </p>
      )}
      <p className="muted">只授权这一次；网页内容仍会被当作不可信材料。</p>
      <div className="button-row">
        <button type="button" className="primary" disabled={busy} onClick={() => void onDecide("granted")}>
          允许
        </button>
        <button type="button" className="danger" disabled={busy} onClick={() => void onDecide("denied")}>
          拒绝
        </button>
      </div>
    </section>
  );
}
