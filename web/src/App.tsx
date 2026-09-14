import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  ChatPayloadMsg,
  HermesRunEvent,
  SupervisorSettings,
  SupervisorStatus,
} from "./api";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  image?: string; // transient data URL (not persisted)
}

interface ToolInfo {
  tool: string;
  preview: string;
  state: "running" | "done" | "error";
  duration?: number;
}

interface HFolder {
  id: string;
  title: string;
  updatedAt: number;
  messages: Message[];
}

const LS_MODEL = "hcModel";
const LS_VISION = "hcVisionModel";
const LS_REASONING = "hcReasoning";
const LS_TOOLS = "hcToolProgress";
const LS_CONVS = "hcConversations";
const LS_ATTACH = "hcAttach";
const LS_VOICE = "hcVoice";
const MAX_CONVS = 30;

const TERMINAL_EVENTS = new Set([
  "run.completed",
  "run.failed",
  "run.cancelled",
  "run.error",
  "run.steered",
]);

const SpeechRec = (window as unknown as {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}).SpeechRecognition || (window as unknown as {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}).webkitSpeechRecognition;

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>; resultIndex: number }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start: () => void;
  stop: () => void;
}

function newConversationId(): string {
  return `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `今日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨日";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function fileToResizedDataUrl(file: File, maxDim = 1024, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("canvas unavailable"));
        return;
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("この画像は読み込めません（形式非対応の可能性）"));
    };
    img.src = url;
  });
}

function badge(status: SupervisorStatus | null): { label: string; cls: string } {
  if (!status) return { label: "接続確認中", cls: "badge-unknown" };
  if (status.mode === "up") {
    return {
      label:
        status.active_runs.length > 0
          ? `実行中（${status.active_runs.length}タスク）`
          : status.idle_for_seconds > 0
            ? "待機中"
            : "実行中",
      cls: "badge-up",
    };
  }
  if (status.mode === "starting") return { label: "起動中…", cls: "badge-starting" };
  return { label: "停止中", cls: "badge-down" };
}

export default function App() {
  const [status, setStatus] = useState<SupervisorStatus | null>(null);
  const [settings, setSettings] = useState<SupervisorSettings | null>(null);
  const [convId, setConvId] = useState<string>(newConversationId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [ttl, setTtl] = useState("10");
  const [maxTask, setMaxTask] = useState("0");
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [showTools, setShowTools] = useState<boolean>(
    () => localStorage.getItem(LS_TOOLS) !== "off"
  );
  const [attachOn, setAttachOn] = useState<boolean>(
    () => localStorage.getItem(LS_ATTACH) !== "off"
  );
  const [voiceOn, setVoiceOn] = useState<boolean>(
    () => localStorage.getItem(LS_VOICE) !== "off"
  );
  const [modelList, setModelList] = useState<string[]>([]);
  const [preferredModel, setPreferredModel] = useState<string>(
    () => localStorage.getItem(LS_MODEL) || ""
  );
  // Vision-capable OpenCode Go models verified directly on the device.
  const VISION_MODELS = [
    "minimax-m3",
    "minimax-m2.7",
    "kimi-k3",
    "qwen3.8-max",
    "qwen3.7-max",
    "mimo-v2-omni",
    "deepseek-v4-flash-vision-exp",
  ];
  const [visionModel, setVisionModel] = useState<string>(
    () => localStorage.getItem(LS_VISION) || "minimax-m3"
  );
  // Thinking/Think level: per-request model_options.reasoning_effort.
  // "default" = provider default; "none" disables thinking entirely.
  const [reasoning, setReasoning] = useState<string>(
    () => localStorage.getItem(LS_REASONING) || "low"
  );
  const [convList, setConvList] = useState<HFolder[]>([]);
  const [attach, setAttach] = useState<{ name: string; dataUrl: string } | null>(null);
  const [recog, setRecog] = useState(false);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [busyKind, setBusyKind] = useState<"text" | "image" | null>(null);
  const stickRef = useRef(true);

  const aborter = useRef<AbortController | null>(null);
  const retryRef = useRef<{ text: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const recogRef = useRef<SpeechRecognitionLike | null>(null);

  // Keep messagesRef in lock-step with messages state. React defers updater
  // FUNCTION execution to render time, so writing the ref inside the updater
  // still races async commits (stored EMPTY assistant messages). Instead,
  // compute from the ref AT CALL TIME and pass values — ref updates
  // synchronously, no render dependency.
  const applyMessages = useCallback(
    (updater: (prev: Message[]) => Message[]) => {
      const next = updater(messagesRef.current);
      messagesRef.current = next;
      setMessages(next);
    },
    []
  );

  const saveConvs = useCallback(
    (updater: (prev: HFolder[]) => HFolder[]) => {
      setConvList((prev) => {
        const next = updater(prev);
        try {
          localStorage.setItem(LS_CONVS, JSON.stringify(next.slice(0, MAX_CONVS)));
        } catch {
          /* storage full: drop oldest until it fits */
          for (let n = next.length - 1; n > 0; n--) {
            try {
              localStorage.setItem(LS_CONVS, JSON.stringify(next.slice(0, n)));
              break;
            } catch {
              /* keep shrinking */
            }
          }
        }
        return next;
      });
    },
    []
  );

  const commitConversation = useCallback(() => {
    const msgs = messagesRef.current;
    if (msgs.length === 0) return;
    const firstUser = msgs.find((m) => m.role === "user");
    saveConvs((prev) => {
      const existing = prev.find((c) => c.id === convId);
      const title =
        (existing && existing.title) ||
        (firstUser ? firstUser.content.replace(/\[画像\]/g, "").trim().slice(0, 40) : "");
      const entry: HFolder = {
        id: convId,
        title: title || "（未送信）",
        updatedAt: Date.now(),
        messages: msgs.map(({ id, role, content, error }) => ({ id, role, content, error })),
      };
      const rest = prev.filter((c) => c.id !== convId);
      return [entry, ...rest].slice(0, MAX_CONVS);
    });
  }, [convId, saveConvs]);

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await api.status());
    } catch {
      /* supervisor itself unreachable */
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 2500);
    return () => clearInterval(t);
  }, [refreshStatus]);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setSettings(s);
        setTtl(String(s.idle_ttl_minutes));
        setMaxTask(String(s.max_task_minutes));
      })
      .catch(() => {});
    api
      .modelOptions()
      .then((opts) => {
        const cur = opts.providers.find((p) => p.is_current);
        const models = (cur?.models || []).map((m) =>
          typeof m === "string" ? m : m.id
        );
        setModelList(models);
        if (!preferredModel && opts.model) setPreferredModel(opts.model);
      })
      .catch(() => {});
    try {
      const raw = localStorage.getItem(LS_CONVS);
      if (raw) setConvList(JSON.parse(raw) as HFolder[]);
    } catch {
      /* ignore corrupt history */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stick-to-bottom: only auto-scroll while the user is already at the bottom.
  const onListScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };
  useEffect(() => {
    if (stickRef.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
  }, [messages, tools]);
  useEffect(() => {
    const vp = window.visualViewport;
    if (!vp) return;
    const onVpResize = () => {
      if (stickRef.current) {
        requestAnimationFrame(() =>
          listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
        );
      }
    };
    vp.addEventListener("resize", onVpResize);
    return () => vp.removeEventListener("resize", onVpResize);
  }, []);

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if ((!text && !attach) || busy) return;
      if (override === undefined) setInput("");
      setError(null);
      const attachCopy = attach;
      setAttach(null);

      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: "user",
        content: attachCopy ? (text || "この画像を確認してください") + "\n[画像]" : text,
        image: attachCopy?.dataUrl,
      };
      const assistantMsg: Message = { id: crypto.randomUUID(), role: "assistant", content: "" };
      applyMessages((m) => [...m, userMsg, assistantMsg]);
      setTools([]);
      setBusy(true);
      setBusyKind(attachCopy ? "image" : "text");

      const patchAssistant = (fn: (m: Message) => Message) =>
        applyMessages((m) => m.map((x) => (x.id === assistantMsg.id ? fn(x) : x)));

      if (attachCopy) {
        // Image turns: /v1/chat/completions (runs rejects content arrays),
        // streamed. History is NOT sent in the body: X-Hermes-Session-Id makes
        // the server load the full conversation from state.db (PC-like continuity).
        try {
          const history: ChatPayloadMsg[] = [
            {
              role: "user",
              content: [
                { type: "text", text: text || "この画像を確認してください" },
                { type: "image_url", image_url: { url: attachCopy.dataUrl } },
              ],
            },
          ];
          const controller = new AbortController();
          aborter.current = controller;
          await api.chatCompletionsStream(
            history,
            (full) => patchAssistant((m) => ({ ...m, content: full })),
            () => {},
            (err) => {
              patchAssistant((m) => ({
                ...m,
                content: m.content || `エラー: ${err.message}`,
                error: true,
              }));
              setError(err.message);
            },
            visionModel || "minimax-m3",
            controller.signal,
            convId,
            reasoning
          );
        } catch (err) {
          const msg = (err as Error).message || String(err);
          patchAssistant((m) => ({ ...m, content: `エラー: ${msg}`, error: true }));
          setError(msg);
        } finally {
          setBusy(false);
          setBusyKind(null);
          aborter.current = null;
          commitConversation();
          return;
        }
      }

      const controller = new AbortController();
      aborter.current = controller;
      try {
        const run = await api.createRun(
            text,
            convId,
            preferredModel || undefined,
            reasoning
          );
        const runId = run.run_id;
        let streamed = "";

        await api.runEvents(
          runId,
          {
            onEvent: (ev: HermesRunEvent) => {
              if (ev.event === "message.delta" && typeof ev.delta === "string") {
                streamed += ev.delta;
                patchAssistant((m) => ({ ...m, content: streamed }));
              } else if (ev.event === "run.completed" && typeof ev.output === "string") {
                patchAssistant((m) => ({ ...m, content: ev.output! }));
              } else if (ev.event === "tool.started" && typeof ev.tool === "string") {
                setTools((t) => [
                  ...t,
                  { tool: ev.tool!, preview: ev.preview || "", state: "running" },
                ]);
              } else if (ev.event === "tool.progress" && typeof ev.preview === "string") {
                setTools((t) => {
                  const out = [...t];
                  const last = out[out.length - 1];
                  if (last && last.state === "running") last.preview = ev.preview!;
                  return out;
                });
              } else if (ev.event === "tool.completed") {
                setTools((t) => {
                  const out = [...t];
                  const idx = out.length - 1;
                  if (idx >= 0) {
                    out[idx] = {
                      ...out[idx],
                      state: ev.error ? "error" : "done",
                      duration:
                        typeof ev.duration === "number" ? ev.duration : undefined,
                    };
                  }
                  return out;
                });
              } else if (TERMINAL_EVENTS.has(ev.event) && ev.event !== "run.completed") {
                patchAssistant((m) => ({
                  ...m,
                  content: m.content || `（${ev.event}）`,
                  error: ev.event !== "run.steered",
                }));
              } else if (ev.event === "run.failed" && typeof ev.text === "string") {
                patchAssistant((m) => ({ ...m, content: ev.text!, error: true }));
              }
            },
            onError: (err) => {
              patchAssistant((m) => ({
                ...m,
                content: m.content || `エラー: ${err.message}`,
                error: true,
              }));
              setError(err.message);
            },
            onDone: () => {},
          },
          controller.signal
        );
      } catch (err) {
        const msg = (err as Error).message || String(err);
        applyMessages((m) =>
          m.map((x) =>
            x.id === assistantMsg.id
              ? {
                  ...x,
                  content:
                    x.content ||
                    (msg.includes("hermes_starting")
                      ? "Hermesを起動中…数秒待って再送信してください"
                      : `エラー: ${msg}`),
                  error: true,
                }
              : x
          )
        );
        setError(msg);
        if (msg.includes("hermes_starting") && override === undefined && !retryRef.current) {
          retryRef.current = { text };
          setTimeout(() => {
            const pending = retryRef.current;
            retryRef.current = null;
            if (pending) void send(pending.text);
          }, 4000);
        }
      } finally {
        setBusy(false);
        aborter.current = null;
        setBusyKind(null);
        commitConversation();
        inputRef.current?.focus();
      }
    },
    [input, busy, convId, attach, preferredModel, visionModel, reasoning, commitConversation]
  );

  const cancel = useCallback(() => {
    aborter.current?.abort();
  }, []);

  // --- history ------------------------------------------------------------

  const newChat = useCallback(() => {
    commitConversation();
    applyMessages(() => []);
    setConvId(newConversationId());
    setError(null);
    setShowHistory(false);
  }, [commitConversation, applyMessages]);

  const openConversation = useCallback(
    (id: string) => {
      commitConversation();
      const c = convList.find((x) => x.id === id);
      if (!c) return;
      applyMessages(() =>
        c.messages.map((m) => ({ ...m, content: m.content, error: m.error }))
      );
      setConvId(id);
      setShowHistory(false);
    },
    [commitConversation, convList, applyMessages]
  );

  const deleteConversation = useCallback(
    (id: string) => {
      if (!window.confirm("この会話履歴を削除しますか？（Hermes側の保存には影響しません）")) return;
      saveConvs((prev) => prev.filter((c) => c.id !== id));
      if (id === convId) {
        applyMessages(() => []);
        setConvId(newConversationId());
      }
    },
    [convId, saveConvs, applyMessages]
  );

  // --- attachment ---------------------------------------------------------

  const onPickFile = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      e.target.value = "";
      if (!f) return;
      try {
        const dataUrl = await fileToResizedDataUrl(f);
        if (dataUrl.length > 5_500_000) {
          setError("画像が大きすぎます（圧縮を試すか別の画像を使ってください）");
          return;
        }
        setAttach({ name: f.name, dataUrl });
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    []
  );

  // --- voice input --------------------------------------------------------

  const startRecog = useCallback(() => {
    if (!SpeechRec || recog) return;
    const r = new SpeechRec();
    r.lang = "ja-JP";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e) => {
      let finalText = "";
      let interim = "";
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript;
        else interim += res[0].transcript;
      }
      setInput((prev) => {
        const base = prev.trimEnd();
        // replace a previous interim run with the new one
        return finalText ? `${base ? base + " " : ""}${finalText}` : `${base} ${interim}`.trim();
      });
    };
    r.onend = () => {
      setRecog(false);
      recogRef.current = null;
    };
    r.onerror = () => {
      setRecog(false);
      recogRef.current = null;
    };
    recogRef.current = r;
    setRecog(true);
    try {
      r.start();
    } catch {
      setRecog(false);
    }
  }, [recog]);

  const stopRecog = useCallback(() => {
    recogRef.current?.stop();
    setRecog(false);
  }, []);

  // --- settings -----------------------------------------------------------

  const saveSettings = useCallback(async () => {
    const patch: Partial<SupervisorSettings> = {};
    const t = parseInt(ttl, 10);
    const m = parseInt(maxTask, 10);
    if (Number.isFinite(t) && t >= 1) patch.idle_ttl_minutes = t;
    if (Number.isFinite(m) && m >= 0) patch.max_task_minutes = m;
    try {
      const s = await api.saveSettings(patch);
      // PUT response omits api_key_set (GET includes it): carry the previous
      // value over so the "APIキー未設定" warning can't false-positive.
      setSettings((prev) => ({ ...s, api_key_set: prev?.api_key_set ?? false }));
      setTtl(String(s.idle_ttl_minutes));
      setMaxTask(String(s.max_task_minutes));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [ttl, maxTask]);

  const changeModel = (v: string) => {
    setPreferredModel(v);
    if (v) localStorage.setItem(LS_MODEL, v);
    else localStorage.removeItem(LS_MODEL);
  };
  const changeVisionModel = (v: string) => {
    setVisionModel(v);
    localStorage.setItem(LS_VISION, v);
  };
  const changeReasoning = (v: string) => {
    setReasoning(v);
    localStorage.setItem(LS_REASONING, v);
  };
  const toggleTools = () => {
    setShowTools((v) => {
      localStorage.setItem(LS_TOOLS, v ? "off" : "on");
      return !v;
    });
  };
  const toggleAttach = () => {
    setAttachOn((v) => {
      localStorage.setItem(LS_ATTACH, v ? "off" : "on");
      return !v;
    });
  };
  const toggleVoice = () => {
    setVoiceOn((v) => {
      localStorage.setItem(LS_VOICE, v ? "off" : "on");
      return !v;
    });
  };

  const b = badge(status);
  const voiceSupported = Boolean(SpeechRec);

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" onClick={() => setShowHistory(true)} title="履歴">
          ≡
        </button>
        <div className="brand">
          <span className="logo">H</span>
          <span className="title">Hermes Chat</span>
        </div>
        <div className="top-actions">
          <button
            className="badge"
            onClick={() => status?.mode === "down" && api.start()}
            title={status?.mode === "down" ? "タップで起動" : "Hermes状態"}
          >
            <span className={`dot ${b.cls}`} />
            {b.label}
          </button>
          <button className="icon-btn" onClick={newChat} title="新しいチャット">
            ＋
          </button>
          <button
            className="icon-btn"
            onClick={() => setShowSettings((v) => !v)}
            title="設定"
          >
            ⚙
          </button>
        </div>
      </header>

      {showHistory && (
        <div className="overlay">
          <div className="sheet">
            <div className="hd">
              <h2>履歴</h2>
              <button className="x" onClick={() => setShowHistory(false)}>
                ✕
              </button>
            </div>
            <button className="newbtn" onClick={newChat}>
              ＋ 新しいチャット
            </button>
            <div className="hlist">
              {convList.length === 0 && (
                <div className="hempty">まだ履歴がありません</div>
              )}
              {convList.map((c) => (
                <div
                  key={c.id}
                  className={`hitem ${c.id === convId ? "active" : ""}`}
                  onClick={() => openConversation(c.id)}
                >
                  <div className="hic">💬</div>
                  <div className="hit">
                    <div className="ht">{c.title}</div>
                    <div className="hd2">
                      {fmtDate(c.updatedAt)} · {Math.floor(c.messages.length / 2)}ターン
                    </div>
                  </div>
                  <button
                    className="hdel"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteConversation(c.id);
                    }}
                  >
                    🗑
                  </button>
                </div>
              ))}
            </div>
            <div className="hnote">
              スマホ内に自動保存（最大{MAX_CONVS}件・古いものから順に削除）
            </div>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="settings-sheet">
          <h3>設定（スーパーバイザ）</h3>
          <div className="settings-row">
            <button
              className="primary"
              onClick={() => window.open("http://127.0.0.1:9191", "_blank")}
            >
              日本語設定GUIを開く（APIキー・モデル）
            </button>
          </div>
          <label>
            モデル（この端末の会話に適用）
            <select value={preferredModel} onChange={(e) => changeModel(e.target.value)}>
              <option value="">（Hermes設定のデフォルト）</option>
              {modelList.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label>
            画像モデル（画像を送ったターンで使用）
            <select value={visionModel} onChange={(e) => changeVisionModel(e.target.value)}>
              {VISION_MODELS.map((m) => (
                <option key={m} value={m}>
                  {m === "minimax-m3" ? `${m}（推奨）` : m}
                </option>
              ))}
            </select>
            <small>
              画像入力に対応済みのモデルのみ表示します。テキストターンは上の通常モデルが担当します。
            </small>
          </label>
          <label>
            思考レベル（Think・応答速度を調整）
            <select value={reasoning} onChange={(e) => changeReasoning(e.target.value)}>
              <option value="default">既定（OpenCode Go標準）</option>
              <option value="none">なし（最速・単純な質問向き）</option>
              <option value="low">低（初期値・高速＆高品質のバランス）</option>
              <option value="medium">標準（中）</option>
              <option value="high">高（じっくり・複雑な課題向き・遅い）</option>
            </select>
            <small>
              低やなしにすると応答が速くなります（複雑な課題の品質は下がる場合があります）。画像ターンにも適用されます。
            </small>
          </label>
          <label className="check">
            <span>タスクの進行状況を表示</span>
            <input type="checkbox" checked={showTools} onChange={toggleTools} />
          </label>
          <label className="check">
            <span>画像の添付を有効にする</span>
            <input type="checkbox" checked={attachOn} onChange={toggleAttach} />
          </label>
          <label className="check">
            <span>音声入力を有効にする</span>
            <input type="checkbox" checked={voiceOn} onChange={toggleVoice} />
          </label>
          <label>
            無操作で停止するまでの時間（分）
            <input type="number" min={1} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </label>
          <label>
            1タスクの最大実行時間（分・0=無制限）
            <input type="number" min={0} value={maxTask} onChange={(e) => setMaxTask(e.target.value)} />
          </label>
          <div className="settings-row">
            <button onClick={saveSettings} className="primary">
              保存
            </button>
            <button onClick={() => setShowSettings(false)}>閉じる</button>
          </div>
          <div className="settings-row">
            <button
              className="danger"
              disabled={status?.mode !== "up"}
              onClick={() => {
                if (window.confirm("Hermesを停止しますか？（実行中タスクは中断されます）")) {
                  api.stop();
                }
              }}
            >
              今すぐ停止
            </button>
            {settings && !settings.api_key_set && (
              <span className="warn">
                ⚠ APIキー未設定: supervisor/settings.json に hermes_api_key を入れてください
              </span>
            )}
          </div>
        </div>
      )}

      <main className="chat">
        {status && status.mode !== "up" ? (
          <div className="gate">
            <div className="gate-spin" />
            <p>
              {status.mode === "starting"
                ? "Hermes を起動中…（初回は数十秒かかります）"
                : "Hermes は停止中です"}
            </p>
            {status.mode === "down" && (
              <button
                className="primary big"
                onClick={async () => {
                  try {
                    await api.start();
                  } catch (err) {
                    setError((err as Error).message);
                  }
                }}
              >
                Hermes を起動
              </button>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        ) : (
          <>
            <div className="messages" ref={listRef} onScroll={onListScroll}>
              {messages.length === 0 && (
                <div className="empty">メッセージを送って会話を始めましょう</div>
              )}
              {messages.map((m) => (
                <div key={m.id} className={`row ${m.role}`}>
                  {m.role === "assistant" ? (
                    <div className={`bubble assistant ${m.error ? "error" : ""}`}>
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {m.content || "…"}
                      </Markdown>
                    </div>
                  ) : (
                    <div className="bubble user">
                      {m.image && <img className="msgbubble-img" src={m.image} alt="" />}
                      {m.content.replace(/\[画像\]/g, "")}
                    </div>
                  )}
                </div>
              ))}
              {busy && (
                <div className="typing">
                  {busyKind === "image"
                    ? "画像を解析中…（OpenCode Goが制限中の場合は自動再試行します）"
                    : "Hermes が応答中…"}
                </div>
              )}
              {showTools && tools.length > 0 && (
                <div className="tools-bar">
                  {tools.slice(-4).map((t, i) => (
                    <span key={i} className={`tool-chip ${t.state}`}>
                      {t.state === "running" ? "◌" : t.state === "done" ? "✓" : "✗"}{" "}
                      {t.tool}
                      {t.preview ? `: ${t.preview}` : ""}
                      {t.state === "done" && typeof t.duration === "number"
                        ? ` (${t.duration.toFixed(1)}s)`
                        : ""}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="composer">
              {busy && (
                <button className="cancel" onClick={cancel}>
                  応答を中断
                </button>
              )}
              {attach && (
                <div className="attachrow">
                  <img className="athumb" src={attach.dataUrl} alt="" />
                  <div className="atname">
                    {attach.name}（圧縮済み・送信前に✕で解除）
                  </div>
                  <button className="atdel" onClick={() => setAttach(null)}>
                    ✕
                  </button>
                </div>
              )}
              {showPlusMenu && attachOn && (
                <div className="plusmenu">
                  <button
                    className="mi"
                    onClick={() => {
                      setShowPlusMenu(false);
                      fileRef.current?.click();
                    }}
                  >
                    🖼 写真を選択（ギャラリー）
                  </button>
                  <button
                    className="mi"
                    onClick={() => {
                      setShowPlusMenu(false);
                      camRef.current?.click();
                    }}
                  >
                    📷 カメラで撮影
                  </button>
                  <button
                    className="mi"
                    onClick={() => {
                      setShowPlusMenu(false);
                      fileRef.current?.click();
                    }}
                  >
                    📄 ファイル（現在は画像のみ）
                  </button>
                </div>
              )}
              <div className="inputrow">
                {attachOn && (
                  <>
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/*"
                      style={{ display: "none" }}
                      onChange={onPickFile}
                    />
                    <input
                      ref={camRef}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      style={{ display: "none" }}
                      onChange={onPickFile}
                    />
                    <button
                      className="icon plus"
                      title="添付メニュー"
                      onClick={() => setShowPlusMenu((v) => !v)}
                    >
                      ＋
                    </button>
                  </>
                )}
                <textarea
                  ref={inputRef}
                  rows={1}
                  placeholder="メッセージを入力（＋で画像・カメラ）"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                {voiceOn && voiceSupported && (
                  <button
                    className={`icon mic ${recog ? "live" : ""}`}
                    title={recog ? "認識を確定" : "音声入力"}
                    onClick={recog ? stopRecog : startRecog}
                  >
                    🎤
                  </button>
                )}
                <button
                  className="send"
                  disabled={(!input.trim() && !attach) || busy}
                  onClick={() => void send()}
                >
                  ➤
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}