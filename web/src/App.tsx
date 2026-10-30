import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  type ActionView,
  type Contact,
  type Health,
  type ThreadState,
} from "./api.ts";
import { ActionCard, type ActionConfirmResult } from "./components/ActionCard.tsx";
import { Chat, fileToBase64 } from "./components/Chat.tsx";
import { ContactList } from "./components/ContactList.tsx";
import { MemoryReview } from "./components/MemoryReview.tsx";
import { PermissionCard } from "./components/PermissionCard.tsx";
import { Questionnaire } from "./components/Questionnaire.tsx";

type LiveTool = { id: string; name: string; status: "running" | "done" | "error" };

const THREAD_KEY = "ra.threadId";
const CONTACT_KEY = "ra.contactId";

export function App() {
  const [threadId, setThreadId] = useState<string | null>(() => localStorage.getItem(THREAD_KEY));
  const [state, setState] = useState<ThreadState | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [activeContactId, setActiveContactId] = useState<string | null>(() =>
    localStorage.getItem(CONTACT_KEY),
  );
  const [health, setHealth] = useState<Health | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<ActionConfirmResult | null>(null);
  const [lastAction, setLastAction] = useState<ActionView | null>(null);
  const stateRef = useRef<ThreadState | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const refreshThread = useCallback(async (id: string) => {
    const data = await api.getThread(id);
    setState(data);
    return data;
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const [h, c] = await Promise.all([api.health(), api.getContacts()]);
        if (cancelled) return;
        setHealth(h);
        setContacts(c.contacts);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }

      let id = threadId;
      if (!id) {
        try {
          const created = await api.createThread("Relationship Agent");
          id = created.id;
          if (!cancelled) {
            setThreadId(id);
            localStorage.setItem(THREAD_KEY, id);
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          return;
        }
      }

      try {
        const data = await api.getThread(id);
        if (!cancelled) setState(data);
      } catch {
        // localStorage 里的 thread 可能已经被重置，建一个新的。
        try {
          const created = await api.createThread("Relationship Agent");
          if (!cancelled) {
            setThreadId(created.id);
            localStorage.setItem(THREAD_KEY, created.id);
            setState(await api.getThread(created.id));
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // 只在首次挂载时跑；后续切换 thread 由 newThread 处理。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据库可能比页面晚启动；每 5 秒重新探一次，徽标不用手动刷新。
  useEffect(() => {
    const timer = setInterval(() => {
      void api
        .health()
        .then(setHealth)
        .catch(() => setHealth(null));
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!threadId) return;
    void refreshThread(threadId).catch((err) => setError(String(err)));
  }, [threadId, refreshThread]);

  // SSE：事件断线由 EventSource 自动重连；run_completed 后主动关闭。
  useEffect(() => {
    if (!activeRunId || !threadId) return;
    const source = new EventSource(`/api/runs/${activeRunId}/events`);

    const on = (type: string) => (event: MessageEvent<string>) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(event.data) as Record<string, unknown>;
      } catch {
        payload = {};
      }

      if (type === "message_delta") {
        setStreamingText((current) => current + String(payload.delta ?? ""));
        return;
      }
      if (type === "tool_started") {
        const id = String(payload.toolCallId ?? "");
        const name = String(payload.toolName ?? "tool");
        setLiveTools((current) => [...current, { id, name, status: "running" }]);
        return;
      }
      if (type === "tool_finished") {
        const id = String(payload.toolCallId ?? "");
        const isError = Boolean(payload.isError);
        setLiveTools((current) =>
          current.map((tool) =>
            tool.id === id ? { ...tool, status: isError ? "error" : "done" } : tool,
          ),
        );
        return;
      }
      if (type === "error") {
        setError(String(payload.message ?? "运行失败"));
        setBusy(false);
        setActiveRunId(null);
        return;
      }
      if (type === "run_completed") {
        setBusy(false);
        setActiveRunId(null);
        setStreamingText("");
        setLiveTools([]);
        void refreshThread(threadId)
          .then(() => setActionResult(null))
          .catch((err) => setError(String(err)));
        return;
      }

      // questionnaire / permission_request / action_proposed：刷新后由右侧面板接管。
      void refreshThread(threadId).catch((err) => setError(String(err)));
    };

    const types = [
      "run_started",
      "message_delta",
      "tool_started",
      "tool_finished",
      "questionnaire",
      "permission_request",
      "action_proposed",
      "run_completed",
      "error",
    ];
    const listeners = types.map((type) => {
      const handler = on(type);
      source.addEventListener(type, handler as EventListener);
      return { type, handler };
    });

    return () => {
      for (const { type, handler } of listeners) {
        source.removeEventListener(type, handler as EventListener);
      }
      source.close();
    };
  }, [activeRunId, threadId, refreshThread]);

  const startRun = async (runId: string) => {
    setStreamingText("");
    setLiveTools([]);
    setBusy(true);
    setActionResult(null);
    setLastAction(null);
    setActiveRunId(runId);
  };

  const handleSend = async (text: string, files: File[], mode: "ask" | "full") => {
    if (!threadId || busy) return;
    setError(null);
    setActionResult(null);
    setLastAction(null);
    try {
      const images = await Promise.all(files.map(fileToBase64));
      const started = await api.sendMessage(threadId, {
        text,
        images,
        pageContext: { contactId: activeContactId },
        permissionMode: mode,
        requestId: crypto.randomUUID(),
      });
      await startRun(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleAnswer = async (answers: Record<string, string | string[]>) => {
    const questionnaire = stateRef.current?.pendingQuestionnaire;
    if (!questionnaire) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.answerQuestionnaire(questionnaire.id, answers);
      await refreshThread(threadId!);
      await startRun(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handlePermission = async (decision: "granted" | "denied") => {
    const permission = stateRef.current?.pendingPermission;
    if (!permission) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.decidePermission(permission.id, decision);
      await refreshThread(threadId!);
      await startRun(started.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  const handleConfirm = async () => {
    const action = stateRef.current?.pendingAction;
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.confirmAction(action.id);
      setActionResult(result);
      setLastAction(action);
      await refreshThread(threadId!);
      // 新建/更新/合并都会改联系人列表；无论当前有没有选中联系人都要刷新。
      const updated = await api.getContacts();
      setContacts(updated.contacts);
      const actual = result.receipt.actual_result as { contactId?: string } | null;
      if (actual?.contactId) {
        // 新建/更新后直接选中目标联系人，右侧记忆面板会跟着切过去。
        setActiveContactId(actual.contactId);
        localStorage.setItem(CONTACT_KEY, actual.contactId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    const action = stateRef.current?.pendingAction;
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await api.rejectAction(action.id);
      await refreshThread(threadId!);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const newThread = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createThread("Relationship Agent");
      setThreadId(created.id);
      localStorage.setItem(THREAD_KEY, created.id);
      setState(null);
      setActiveRunId(null);
      setStreamingText("");
      setLiveTools([]);
      setActionResult(null);
      setLastAction(null);
      setState(await api.getThread(created.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const activeContact = contacts.find((contact) => contact.id === activeContactId) ?? null;
  const pendingAction = state?.pendingAction ?? null;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">RA</span>
          <div>
            <h1>Relationship Agent</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`health ${health?.db === "ok" ? "ok" : "bad"}`}>
            DB {health?.db ?? "…"} · {health?.version ?? "?"}
          </span>
          <button type="button" className="small" onClick={() => void newThread()} disabled={busy}>
            新会话
          </button>
        </div>
      </header>

      {error && (
        <div className="banner error">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      <main className="layout">
        <aside className="sidebar">
          <ContactList
            contacts={contacts}
            activeId={activeContactId}
            onSelect={(contact) => {
              setActiveContactId(contact.id);
              localStorage.setItem(CONTACT_KEY, contact.id);
            }}
          />
        </aside>

        <div className="main-column">
          <Chat
            state={state}
            streamingText={streamingText}
            liveTools={liveTools}
            busy={busy}
            activeContactName={activeContact?.display_name ?? null}
            onSend={handleSend}
          />
        </div>

        <aside className="rightbar">
          {pendingAction && (
            <ActionCard
              action={pendingAction}
              busy={busy}
              result={null}
              onConfirm={handleConfirm}
              onReject={handleReject}
            />
          )}

          {lastAction && actionResult && !pendingAction && (
            <ActionCard
              action={lastAction}
              busy={true}
              result={actionResult}
              onConfirm={async () => undefined}
              onReject={async () => undefined}
            />
          )}

          {state?.pendingQuestionnaire && (
            <Questionnaire
              questionnaire={state.pendingQuestionnaire}
              busy={busy}
              onSubmit={handleAnswer}
            />
          )}

          {state?.pendingPermission && (
            <PermissionCard
              permission={state.pendingPermission}
              busy={busy}
              onDecide={handlePermission}
            />
          )}

          {activeContact ? (
            <MemoryReview
              contactId={activeContact.id}
              contactName={activeContact.display_name}
            />
          ) : (
            <section className="panel hint">
              <p className="muted small">选择一个联系人，查看和审核他的长期记忆。</p>
            </section>
          )}
        </aside>
      </main>
    </div>
  );
}
