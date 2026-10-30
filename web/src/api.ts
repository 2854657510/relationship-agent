export interface Contact {
  id: string;
  display_name: string;
  version: number;
  updated_at: string;
}

export interface ThreadMessage {
  seq: number;
  role: "user" | "assistant" | "toolResult" | "system" | string;
  payload: {
    role?: string;
    content?: unknown;
    toolName?: string;
    toolCallId?: string;
    [key: string]: unknown;
  };
  created_at: string;
}

export interface ActionView {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  rationale: string | null;
  evidence_ids: string[];
  base_version: number | null;
  status: string;
}

export interface QuestionnaireView {
  id: string;
  questions: Array<{
    id: string;
    prompt: string;
    kind: "single_choice" | "multi_choice" | "text" | "date";
    options?: string[];
    required?: boolean;
  }>;
  status: string;
}

export interface PermissionView {
  id: string;
  tool_name: string;
  args: Record<string, unknown>;
  status: string;
}

export interface ThreadState {
  thread: {
    id: string;
    title: string | null;
    compaction_summary: string | null;
    created_at: string;
    updated_at: string;
  };
  messages: ThreadMessage[];
  pendingQuestionnaire: QuestionnaireView | null;
  pendingPermission: PermissionView | null;
  pendingAction: ActionView | null;
}

export interface MemoryCandidate {
  id: string;
  contactId: string;
  kind: string;
  content: string;
  evidenceIds: string[];
  sourceInsightId: string | null;
  createdAt: string;
}

export interface MemoryDocumentView {
  id: string;
  contactId: string;
  version: number;
  contentMarkdown: string;
  status: "draft" | "active" | "archived";
  basedOnVersion: number | null;
  evidenceIds: string[];
  createdAt: string;
  approvedAt: string | null;
}

export interface MemoryView {
  candidates: MemoryCandidate[];
  confirmed: MemoryCandidate[];
  draft: MemoryDocumentView | null;
  active: MemoryDocumentView | null;
}

export interface Health {
  status: string;
  db: string;
  version: string;
  time: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export const api = {
  health: () => request<Health>("/api/health"),
  createThread: (title?: string) =>
    request<{ id: string }>("/api/threads", {
      method: "POST",
      body: JSON.stringify({ title }),
    }),
  getThread: (id: string) => request<ThreadState>(`/api/threads/${id}`),
  sendMessage: (
    threadId: string,
    body: {
      text?: string;
      images: Array<{ mimeType: string; dataBase64: string }>;
      pageContext: { contactId?: string | null };
      permissionMode: "ask" | "full";
      requestId: string;
    },
  ) =>
    request<{ runId: string; existing: boolean }>(`/api/threads/${threadId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  answerQuestionnaire: (id: string, answers: Record<string, string | string[]>) =>
    request<{ runId: string }>(`/api/questionnaires/${id}/answer`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    }),
  decidePermission: (id: string, decision: "granted" | "denied") =>
    request<{ runId: string }>(`/api/permissions/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ decision }),
    }),
  confirmAction: (id: string) =>
    request<{
      actionId: string;
      status: string;
      receipt: { id: string; status: string; actual_result: unknown; error: string | null };
      insight: Array<{ status: string; error?: string }>;
    }>(`/api/actions/${id}/confirm`, { method: "POST", body: "{}" }),
  rejectAction: (id: string) =>
    request<{ actionId: string; status: string }>(`/api/actions/${id}/reject`, {
      method: "POST",
      body: "{}",
    }),
  getContacts: () => request<{ contacts: Contact[] }>("/api/contacts"),
  getContact: (id: string, threadId?: string) =>
    request<{ snapshot: unknown; rendered: string }>(
      `/api/contacts/${id}${threadId ? `?threadId=${threadId}` : ""}`,
    ),
  getMemory: (contactId: string) => request<MemoryView>(`/api/contacts/${contactId}/memory`),
  generateDraft: (contactId: string, baseVersion?: number) =>
    request<MemoryDocumentView>(`/api/contacts/${contactId}/memory-drafts`, {
      method: "POST",
      body: JSON.stringify({ baseVersion }),
    }),
  approveDraft: (draftId: string, baseVersion?: number) =>
    request<MemoryDocumentView>(`/api/memory-drafts/${draftId}/approve`, {
      method: "POST",
      body: JSON.stringify({ baseVersion }),
    }),
  rejectDraft: (draftId: string) =>
    request<{ id: string; status: string }>(`/api/memory-drafts/${draftId}/reject`, {
      method: "POST",
      body: "{}",
    }),
  confirmMemoryItem: (id: string) =>
    request<{ id: string; status: string }>(`/api/memory-items/${id}/confirm`, {
      method: "POST",
      body: "{}",
    }),
  rejectMemoryItem: (id: string) =>
    request<{ id: string; status: string }>(`/api/memory-items/${id}/reject`, {
      method: "POST",
      body: "{}",
    }),
};
