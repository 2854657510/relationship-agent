import { useEffect, useState } from "react";
import { api, type MemoryView } from "../api.ts";

interface MemoryReviewProps {
  contactId: string;
  contactName: string;
}

export function MemoryReview({ contactId, contactName }: MemoryReviewProps) {
  const [memory, setMemory] = useState<MemoryView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    try {
      setMemory(await api.getMemory(contactId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
  }, [contactId]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel memory-review">
      <div className="panel-head">
        <div>
          <p className="eyebrow">Memory Review</p>
          <h3>{contactName}</h3>
        </div>
        <button
          type="button"
          className="small"
          disabled={busy}
          onClick={() => void run(() => api.generateDraft(contactId, memory?.active?.version ?? 0))}
        >
          生成文档草案
        </button>
      </div>

      {error && <p className="error">{error}</p>}
      {!memory && !error && <p className="muted">加载长期记忆…</p>}

      {memory?.active && (
        <div className="memory-block">
          <div className="memory-title">
            <strong>当前长期文档</strong>
            <span className="badge">v{memory.active.version}</span>
          </div>
          <pre className="markdown">{memory.active.contentMarkdown}</pre>
        </div>
      )}

      {memory?.draft && (
        <div className="memory-block draft">
          <div className="memory-title">
            <strong>待审核草案</strong>
            <span className="badge warn">v{memory.draft.version}</span>
          </div>
          <pre className="markdown">{memory.draft.contentMarkdown}</pre>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void run(() => api.approveDraft(memory.draft!.id, memory.draft!.basedOnVersion ?? 0))}
            >
              批准
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => void run(() => api.rejectDraft(memory.draft!.id))}
            >
              驳回
            </button>
          </div>
        </div>
      )}

      <div className="memory-block">
        <div className="memory-title">
          <strong>候选记忆</strong>
          <span className="badge">{memory?.candidates.length ?? 0}</span>
        </div>
        {memory && memory.candidates.length === 0 && <p className="muted">暂无待审核候选。</p>}
        {memory?.candidates.map((item) => (
          <div className="candidate" key={item.id}>
            <p>
              <span className="chip">{item.kind}</span> {item.content}
            </p>
            <p className="muted small">
              来源：{item.evidenceIds.map((id) => id.slice(0, 8)).join("、") || "无"}
            </p>
            <div className="button-row">
              <button
                type="button"
                className="small primary"
                disabled={busy}
                onClick={() => void run(() => api.confirmMemoryItem(item.id))}
              >
                确认
              </button>
              <button
                type="button"
                className="small danger"
                disabled={busy}
                onClick={() => void run(() => api.rejectMemoryItem(item.id))}
              >
                拒绝
              </button>
            </div>
          </div>
        ))}
      </div>

      {memory && memory.confirmed.length > 0 && (
        <details className="memory-block">
          <summary>已确认记忆（{memory.confirmed.length}）</summary>
          {memory.confirmed.map((item) => (
            <p key={item.id} className="small">
              <span className="chip">{item.kind}</span> {item.content}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
