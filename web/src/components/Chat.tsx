import { useEffect, useRef, useState } from "react";
import type { ThreadMessage, ThreadState } from "../api.ts";

interface LiveTool {
  id: string;
  name: string;
  status: "running" | "done" | "error";
}

interface ChatProps {
  state: ThreadState | null;
  streamingText: string;
  liveTools: LiveTool[];
  busy: boolean;
  activeContactName: string | null;
  onSend: (text: string, images: File[], permissionMode: "ask" | "full") => Promise<void>;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && "type" in part) {
        if (part.type === "text" && "text" in part) return String(part.text);
        if (part.type === "thinking") return "";
        if (part.type === "toolCall" && "name" in part) return `[工具 ${String(part.name)}]`;
      }
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function toolNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is { type: "toolCall"; name: string } =>
        Boolean(part && typeof part === "object" && part.type === "toolCall" && "name" in part),
    )
    .map((part) => part.name);
}

function imagesFromContent(content: unknown): Array<{ data: string; mimeType: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter(
      (part): part is { type: "image"; data: string; mimeType: string } =>
        Boolean(
          part &&
            typeof part === "object" &&
            part.type === "image" &&
            "data" in part &&
            "mimeType" in part,
        ),
    )
    .map((part) => ({ data: part.data, mimeType: part.mimeType }));
}

function MessageBubble({ message }: { message: ThreadMessage }) {
  const role = message.role;
  const content = message.payload?.content;

  if (role === "user") {
    return (
      <article className="bubble user">
        <div className="bubble-label">你</div>
        <p>{textFromContent(content) || "（图片）"}</p>
        <div className="bubble-images">
          {imagesFromContent(content).map((image, index) => (
            <img
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              alt="上传图片"
            />
          ))}
        </div>
      </article>
    );
  }

  if (role === "toolResult") {
    return (
      <details className="tool-result">
        <summary>工具结果：{String(message.payload?.toolName ?? "unknown")}</summary>
        <pre>{textFromContent(content) || "（无文本）"}</pre>
      </details>
    );
  }

  const tools = toolNames(content);
  return (
    <article className="bubble assistant">
      <div className="bubble-label">Relationship Agent</div>
      {textFromContent(content) && <p>{textFromContent(content)}</p>}
      {tools.length > 0 && (
        <div className="tool-chips">
          {tools.map((name) => (
            <span key={name} className="chip">
              {name}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

export function fileToBase64(file: File): Promise<{ mimeType: string; dataBase64: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      if (comma === -1) {
        reject(new Error("图片格式不支持"));
        return;
      }
      resolve({
        mimeType: file.type,
        dataBase64: result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  });
}

export function Chat({
  state,
  streamingText,
  liveTools,
  busy,
  activeContactName,
  onSend,
}: ChatProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [mode, setMode] = useState<"ask" | "full">("ask");
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state?.messages.length, streamingText, liveTools.length]);

  const handleSend = async () => {
    if (busy || sending) return;
    const trimmed = text.trim();
    if (!trimmed && files.length === 0) return;
    setSending(true);
    try {
      await onSend(trimmed, files, mode);
      setText("");
      setFiles([]);
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="chat">
      <div className="chat-head">
        <div>
          <h2>对话</h2>
          <p className="muted">
            {activeContactName ? `当前联系人：${activeContactName}` : "未指定联系人"}
          </p>
        </div>
        <span className={`badge ${busy ? "busy" : ""}`}>{busy ? "运行中" : "空闲"}</span>
      </div>

      <div className="messages">
        {!state && <p className="muted">加载会话…</p>}
        {state?.messages.map((message) => (
          <MessageBubble key={`${message.seq}-${message.role}`} message={message} />
        ))}

        {streamingText && (
          <article className="bubble assistant streaming">
            <div className="bubble-label">Relationship Agent</div>
            <p>{streamingText}</p>
          </article>
        )}

        {liveTools.length > 0 && (
          <div className="live-tools">
            {liveTools.map((tool) => (
              <span key={tool.id} className={`chip ${tool.status}`}>
                {tool.name}
                {tool.status === "running" ? "…" : tool.status === "error" ? " ×" : " ✓"}
              </span>
            ))}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="composer">
        <div className="composer-row">
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void handleSend();
              }
            }}
            placeholder="说说你想做什么，例如：帮我约张三下周三下午三点喝咖啡"
            rows={3}
          />
          <div className="composer-actions">
            <label className="file-button">
              图片
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                hidden
                onChange={(event) => {
                  const selected = Array.from(event.target.files ?? []);
                  setFiles((current) => [...current, ...selected].slice(0, 4));
                  event.target.value = "";
                }}
              />
            </label>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as "ask" | "full")}
              title="工具访问模式"
            >
              <option value="ask">ask（联网需授权）</option>
              <option value="full">full（联网更宽松）</option>
            </select>
            <button type="button" onClick={() => void handleSend()} disabled={busy || sending}>
              {busy || sending ? "处理中…" : "发送"}
            </button>
          </div>
        </div>

        {files.length > 0 && (
          <div className="file-list">
            {files.map((file, index) => (
              <span key={`${file.name}-${index}`} className="file-pill">
                {file.name}
                <button
                  type="button"
                  onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
