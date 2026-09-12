export interface SupervisorStatus {
  mode: "down" | "starting" | "up";
  hermes_up: boolean;
  health_up: boolean;
  child_pid: number | null;
  active_conns: number;
  active_runs: string[];
  last_inbound: number;
  idle_for_seconds: number;
  boot_elapsed: number | null;
}

export interface SupervisorSettings {
  idle_ttl_minutes: number;
  max_task_minutes: number;
  api_key_set: boolean;
}

export interface HermesRunEvent {
  event: string;
  run_id: string;
  timestamp: number;
  delta?: string;
  output?: string;
  text?: string;
  usage?: Record<string, number>;
  tool?: string;
  preview?: string;
  duration?: number;
  error?: boolean;
  [key: string]: unknown;
}

export interface ModelProvider {
  slug: string;
  name: string;
  is_current?: boolean;
  authenticated?: boolean;
  models?: Array<string | { id: string }>;
}

export interface ModelOptions {
  providers: ModelProvider[];
  model?: string;
  provider?: string;
}

export interface ChatPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatPayloadMsg {
  role: "user" | "assistant";
  content: string | ChatPart[];
}

export interface ChatCompletionResp {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export interface RunCreated {
  run_id: string;
  status: string;
  replayed: boolean;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error || body?.message || JSON.stringify(body).slice(0, 200);
    } catch {
      detail = res.statusText;
    }
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  status: () => fetch("/api/supervisor/status").then((r) => json<SupervisorStatus>(r)),
  settings: () => fetch("/api/supervisor/settings").then((r) => json<SupervisorSettings>(r)),
  saveSettings: (patch: Partial<{ idle_ttl_minutes: number; max_task_minutes: number }>) =>
    fetch("/api/supervisor/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<SupervisorSettings>(r)),
  start: () => fetch("/api/supervisor/start", { method: "POST" }).then((r) => json<SupervisorStatus>(r)),
  stop: () => fetch("/api/supervisor/stop", { method: "POST" }).then((r) => json<SupervisorStatus>(r)),

  createRun: (input: string, conversation: string, model?: string) =>
    fetch("/v1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        model
          ? { input, session_id: conversation, model }
          : { input, session_id: conversation }
      ),
    }).then((r) => json<RunCreated>(r)),

  modelOptions: () =>
    fetch("/api/model/options").then((r) => json<ModelOptions>(r)),

  /** Image-bearing turns go through /v1/chat/completions (runs rejects content arrays). */
  chatCompletions: (
    messages: ChatPayloadMsg[],
    model?: string,
    maxTokens = 800
  ) =>
    fetch("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || undefined,
        messages,
        stream: false,
        max_tokens: maxTokens,
      }),
    }).then((r) => json<ChatCompletionResp>(r)),

  chatCompletionsStream: (
    messages: ChatPayloadMsg[],
    onDelta: (full: string) => void,
    onDone: () => void,
    onError: (err: Error) => void,
    model?: string,
    signal?: AbortSignal,
    sessionId?: string
  ): Promise<void> =>
    (async () => {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (sessionId) {
          // Join the same Hermes session as the runs turns: the server then loads
          // full history from state.db and stores this turn in the conversation.
          headers["X-Hermes-Session-Id"] = sessionId;
          headers["X-Hermes-Session-Key"] = sessionId;
        }
        const res = await fetch("/v1/chat/completions", {
          method: "POST",
          headers,
          body: JSON.stringify({
            model: model || undefined,
            messages,
            stream: true,
            max_tokens: 1200,
          }),
          signal,
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error("no response body");
        const decoder = new TextDecoder();
        let buf = "";
        let full = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk?.choices?.[0]?.delta?.content;
              if (typeof delta === "string") {
                full += delta;
                onDelta(full);
              }
            } catch {
              /* ignore malformed frames */
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          onError(err as Error);
          return;
        }
      }
      onDone();
    })(),

  /** Stream /v1/runs/{id}/events (SSE). Never resolves; callers use the callbacks. */
  async runEvents(
    runId: string,
    handlers: {
      onEvent: (ev: HermesRunEvent) => void;
      onError: (err: Error) => void;
      onDone: () => void;
    },
    signal: AbortSignal
  ): Promise<void> {
    const res = await fetch(`/v1/runs/${encodeURIComponent(runId)}/events`, { signal });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      handlers.onError(new Error(`events ${res.status} ${text.slice(0, 120)}`));
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      handlers.onError(new Error("no response body"));
      return;
    }
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            handlers.onEvent(JSON.parse(payload) as HermesRunEvent);
          } catch {
            /* ignore malformed frames */
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") handlers.onError(err as Error);
    } finally {
      handlers.onDone();
    }
  },
};