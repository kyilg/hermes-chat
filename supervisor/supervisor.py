#!/usr/bin/env python3
"""
Hermes Chat supervisor (waker + reverse proxy + idle power control).

Single always-on, stdlib-only process that owns the public port (default 8642):

  * serves the PWA (static files under WEB_ROOT, default ../web/dist)
  * reverse-proxies /v1/* and /health to the Hermes API server (default
    http://127.0.0.1:8643), injecting the API key from settings so the
    PWA never holds a secret
  * starts Hermes on demand (HERMES_START_CMD) when traffic arrives while
    it is down, and serves a 503/JSON "starting" response until /health OK
  * stops Hermes gracefully after IDLE_TTL_MINUTES of no activity AND no
    in-flight connections AND no active runs (POST /v1/runs bookkeeping);
    hard cap MAX_TASK_MINUTES is the escape hatch for runaway tasks
  * exposes /api/supervisor/status + /api/supervisor/settings (GET/PUT)
    for the PWA

Tuned for Android/Termux: does NOT hold a wake lock itself; Hermes-side
scripts should hold termux-wake-lock only while Hermes is up. CPU when idle
is ~0; memory is one Python process (~10-30 MB).

Environment variables (all optional):
  SUPERVISOR_PORT         listen port (default 8642)
  SUPERVISOR_HOST         bind address (default 127.0.0.1)
  HERMES_API_URL          upstream API server (default http://127.0.0.1:8643)
  WEB_ROOT                static UI root (default <script_dir>/../web/dist)
  HERMES_CHAT_SETTINGS    settings JSON path (default <script_dir>/settings.json)
  HERMES_START_CMD        command to boot Hermes (default ["hermes","gateway","run"])
  HERMES_HOME             optional HERMES_HOME for the child process
  POLL_INTERVAL_S         idle watcher cadence (default 15)
  BOOT_TIMEOUT_S          max seconds to wait for /health after start (default 120)
  SHUTDOWN_GRACE_S        seconds between SIGTERM and SIGKILL (default 30)
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
import urllib.parse
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s supervisor %(levelname)s %(message)s",
)
log = logging.getLogger("supervisor")

HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------
# settings (persisted JSON: idle TTL etc., editable from the PWA)
# ---------------------------------------------------------------------------

DEFAULT_SETTINGS = {
    "idle_ttl_minutes": 10,
    "max_task_minutes": 0,       # 0 = unlimited
    "hermes_api_key": "",        # injected into proxied /v1 requests
}


class SettingsStore:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self.data = dict(DEFAULT_SETTINGS)
        self._load()

    def _load(self) -> None:
        try:
            if self.path.exists():
                with open(self.path, "r", encoding="utf-8") as fh:
                    stored = json.load(fh)
                if isinstance(stored, dict):
                    self.data.update({k: v for k, v in stored.items()
                                      if k in DEFAULT_SETTINGS})
        except Exception as exc:  # noqa: BLE001
            log.warning("settings load failed: %s", exc)

    def get(self, key: str):
        with self._lock:
            return self.data.get(key, DEFAULT_SETTINGS.get(key))

    def put(self, patch: Dict) -> Dict:
        with self._lock:
            for k, v in patch.items():
                if k in DEFAULT_SETTINGS:
                    self.data[k] = v
            snapshot = dict(self.data)
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except Exception as exc:  # noqa: BLE001
            log.warning("settings write failed: %s", exc)
        return snapshot


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------

class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.mode = "down"            # down | starting | up
        self.child: Optional[subprocess.Popen] = None
        self.last_activity = time.time()
        self.last_inbound = 0.0
        self.active_conns = 0
        self.active_runs: Dict[str, float] = {}   # run_id -> started_at
        self.boot_started_at: Optional[float] = None
        self.boot_waiters = 0
        self.boot_ok_at: Optional[float] = None
        self.health_up = False

    def touch_inbound(self) -> None:
        with self.lock:
            now = time.time()
            self.last_inbound = now
            self.last_activity = max(self.last_activity, now)

    def snapshot(self) -> Dict:
        with self.lock:
            now = time.time()
            idle_for = now - self.last_activity if self.mode == "up" else 0.0
            return {
                "mode": self.mode,
                "hermes_up": self.mode == "up",
                "health_up": self.health_up,
                "child_pid": self.child.pid if self.child and self.child.poll() is None else None,
                "active_conns": self.active_conns,
                "active_runs": sorted(self.active_runs),
                "last_inbound": self.last_inbound,
                "idle_for_seconds": max(0, int(idle_for)),
                "boot_elapsed": (now - self.boot_started_at) if self.boot_started_at else None,
            }


class Supervisor:
    def __init__(self, settings: SettingsStore, state: State, upstream: Dict,
                 web_root: Path, start_cmd: List[str], env: Dict):
        self.settings = settings
        self.state = state
        self.upstream = upstream
        self.web_root = web_root
        self.start_cmd = start_cmd
        self.env = env
        self.poll_interval = float(os.environ.get("POLL_INTERVAL_S", "15"))
        self.boot_timeout = float(os.environ.get("BOOT_TIMEOUT_S", "120"))
        self.shutdown_grace = float(os.environ.get("SHUTDOWN_GRACE_S", "30"))

    # -- lifecycle ----------------------------------------------------------

    def start_hermes(self) -> bool:
        st = self.state
        with st.lock:
            if st.mode == "up" or (st.mode == "starting" and st.child and st.child.poll() is None):
                return True
            st.mode = "starting"
            st.boot_started_at = time.time()
            st.boot_ok_at = None
            st.health_up = False
            log.info("starting Hermes: %s", " ".join(self.start_cmd))
            out_fh = open(HERE / "hermes.out", "ab", buffering=0)
            try:
                if os.name == "nt":
                    st.child = subprocess.Popen(
                        self.start_cmd, env=self.env,
                        stdout=out_fh, stderr=subprocess.STDOUT,
                        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
                        start_new_session=False)
                else:
                    st.child = subprocess.Popen(
                        self.start_cmd, env=self.env,
                        stdout=out_fh, stderr=subprocess.STDOUT,
                        start_new_session=True)
            except Exception as exc:  # noqa: BLE001
                log.error("failed to spawn Hermes: %s", exc)
                st.mode = "down"
                return False
        self._spawn_boot_waiter()
        return True

    def _spawn_boot_waiter(self) -> None:
        def waiter() -> None:
            stale = None
            deadline = time.time() + self.boot_timeout
            while time.time() < deadline:
                if self._readiness_ok():
                    # stabilize: let the first-inference path settle before
                    # accepting traffic (cold start closes early requests)
                    time.sleep(3.0)
                    if not self._readiness_ok():
                        continue
                    with self.state.lock:
                        self.state.mode = "up"
                        self.state.health_up = True
                        self.state.boot_ok_at = time.time()
                        self.state.last_activity = time.time()
                    log.info("Hermes is up")
                    return
                time.sleep(3.0)
            with self.state.lock:
                if self.state.mode == "starting":
                    log.error("boot timed out after %.0fs", self.boot_timeout)
                    self.state.mode = "down"
                    self.state.health_up = False
                    stale = self.state.child
                    self.state.child = None
            if stale is not None and stale.poll() is None:
                log.warning("killing stale gateway (pid %s)", stale.pid)
                try:
                    if os.name != "nt":
                        os.killpg(os.getpgid(stale.pid), signal.SIGKILL)
                    else:
                        stale.kill()
                except Exception:  # noqa: BLE001
                    try:
                        stale.kill()
                    except Exception:  # noqa: BLE001
                        pass
        threading.Thread(target=waiter, daemon=True, name="boot-waiter").start()

    def _upstream_headers(self) -> dict:
        key = self.settings.get("hermes_api_key") or ""
        return {"Authorization": f"Bearer {key}"} if key else {}

    def _health_ok(self) -> bool:
        try:
            conn = HTTPConnection(self.upstream["host"], self.upstream["port"],
                                  timeout=3)
            conn.request("GET", "/health", headers=self._upstream_headers())
            resp = conn.getresponse()
            ok = resp.status == 200
            resp.read()
            conn.close()
            return ok
        except Exception:  # noqa: BLE001
            return False

    def _readiness_ok(self) -> bool:
        """True only when the API server platform is genuinely connected.

        /health flips to 200 while the gateway is still warming up, and a
        request fired in that window is closed without a response. Use
        /health/detailed (readiness + api_server platform state) instead;
        fall back to plain /health only when the detailed endpoint cannot be
        reached at all (older versions). NOTE: /health/detailed requires the
        API key (401 without it)."""
        try:
            conn = HTTPConnection(self.upstream["host"], self.upstream["port"],
                                  timeout=3)
            conn.request("GET", "/health/detailed",
                         headers=self._upstream_headers())
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            if resp.status != 200:
                return False
            data = json.loads(body or b"{}")
            readiness = data.get("readiness") or {}
            if readiness.get("status") != "ok":
                return False
            platform = (data.get("platforms") or {}).get("api_server") or {}
            return platform.get("state") == "connected"
        except Exception:  # noqa: BLE001
            return self._health_ok()

    def stop_hermes(self, manual: bool = False) -> None:
        st = self.state
        with st.lock:
            child = st.child
            st.mode = "down"
            st.health_up = False
            st.boot_ok_at = None
            st.active_runs = {}
            st.child = None
        if child is None or child.poll() is not None:
            log.info("stop: nothing running")
            return
        log.info("stopping Hermes (pid %s)%s", child.pid,
                 " [manual]" if manual else " [idle]")
        try:
            if os.name != "nt":
                os.killpg(os.getpgid(child.pid), signal.SIGTERM)
            else:
                child.terminate()
        except Exception:  # noqa: BLE001
            child.terminate()
        try:
            child.wait(timeout=self.shutdown_grace)
            log.info("Hermes stopped cleanly")
        except subprocess.TimeoutExpired:
            log.warning("grace elapsed; SIGKILL")
            try:
                child.kill()
            except Exception:  # noqa: BLE001
                pass
            child.wait(timeout=10)

    def _wait_ready(self, max_wait: float = 90.0) -> None:
        """Poll until the upstream is genuinely ready (restarting as needed).

        Used between proxy retry attempts: a transient failure usually means
        the gateway hard-crashed (native abort), so we make sure a gateway is
        booting and wait for real readiness instead of hammering a dead port."""
        deadline = time.time() + max_wait
        while time.time() < deadline:
            with self.state.lock:
                mode = self.state.mode
            if mode == "down":
                self.start_hermes()
            elif mode == "up" and self._readiness_ok():
                return
            time.sleep(2.0)

    # -- run bookkeeping ----------------------------------------------------

    def note_run_created(self, run_id: str) -> None:
        with self.state.lock:
            self.state.active_runs[run_id] = time.time()
        log.info("run %s created", run_id)
        threading.Thread(target=self._run_watcher, args=(run_id,),
                         daemon=True, name=f"run-{run_id[:8]}").start()

    def _terminal_status(self, status: str) -> bool:
        return str(status or "").lower() in {
            "completed", "cancelled", "failed", "stopped", "error", "expired",
        }

    def _run_watcher(self, run_id: str) -> None:
        while True:
            with self.state.lock:
                if run_id not in self.state.active_runs:
                    return
                started = self.state.active_runs[run_id]
                max_task_min = float(self.settings.get("max_task_minutes") or 0)
            if max_task_min > 0 and time.time() - started > max_task_min * 60.0:
                log.warning("run %s exceeded max_task_minutes=%s; force stop",
                            run_id, int(max_task_min))
                threading.Thread(target=self.stop_hermes, daemon=True,
                                 name="max-task-stop").start()
                return
            status = self._run_status(run_id)
            if status is None:
                # unknown/404: double-check before giving up
                time.sleep(self.poll_interval)
                status = self._run_status(run_id)
                if status is None:
                    with self.state.lock:
                        self.state.active_runs.pop(run_id, None)
                    log.warning("run %s no longer queryable; dropped", run_id)
                    return
            if self._terminal_status(status):
                with self.state.lock:
                    self.state.active_runs.pop(run_id, None)
                    self.state.last_activity = time.time()
                log.info("run %s finished (%s)", run_id, status)
                return
            time.sleep(self.poll_interval)

    def _run_status(self, run_id: str) -> Optional[str]:
        try:
            conn = HTTPConnection(self.upstream["host"], self.upstream["port"],
                                  timeout=5)
            key = self.settings.get("hermes_api_key")
            headers = {"Authorization": f"Bearer {key}"} if key else {}
            conn.request("GET", f"/v1/runs/{urllib.parse.quote(run_id)}",
                         headers=headers)
            resp = conn.getresponse()
            body = resp.read()
            conn.close()
            if resp.status == 200:
                return (json.loads(body) or {}).get("status")
            if resp.status == 404:
                return None
            return None
        except Exception:  # noqa: BLE001
            return None

    def proxy_dashboard(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        """Reverse-proxy the Hermes web dashboard, injecting a script that
        forces locale=ja (the dashboard stores its language in localStorage on
        ITS origin, so the injection must be served from this origin).

        Admin pages (Keys/Models/Settings/etc.) work; the Chat tab uses
        WebSockets, which this stdlib proxy does not relay."""
        dash = getattr(self, "dashboard", None)
        if not dash:
            handler.send_json(503, {"error": "dashboard_proxy_unconfigured"})
            return
        conn: Optional[HTTPConnection] = None
        try:
            conn = HTTPConnection(dash["host"], dash["port"], timeout=60)
            body = handler.rfile.read(int(handler.headers.get("Content-Length", "0") or 0)) \
                if handler.command in ("POST", "PUT", "PATCH") else None
            headers = {k: v for k, v in handler.headers.items()
                       if k.lower() not in ("host", "authorization",
                                            "connection", "transfer-encoding",
                                            "content-length", "upgrade",
                                            "accept-encoding")}
            headers["Host"] = f"{dash['host']}:{dash['port']}"
            headers["Accept-Encoding"] = "identity"
            conn.request(handler.command, path, body=body, headers=headers)
            resp = conn.getresponse()
            raw = resp.read()
            lower_headers = {k.lower(): v for k, v in resp.getheaders()}
            ctype = lower_headers.get("content-type", "") or ""
            if "text/html" in ctype and resp.status == 200:
                text = raw.decode("utf-8", "replace")
                script = ("<script>try{localStorage.setItem('hermes-locale','ja');}"
                          "catch(e){}</script>")
                if "</head>" in text and "hermes-locale" not in text:
                    text = text.replace("</head>", script + "</head>", 1)
                    raw = text.encode("utf-8")
            handler.send_response_only(resp.status, resp.reason or "")
            for k, v in resp.getheaders():
                if k.lower() in ("transfer-encoding", "content-length",
                                 "connection", "keep-alive", "upgrade"):
                    continue
                handler.send_header(k, v)
            handler.send_header("Content-Length", str(len(raw)))
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(raw)
            handler.wfile.flush()
        except Exception as exc:  # noqa: BLE001
            log.warning("dashboard proxy error %s %s: %s", handler.command, path, exc)
            try:
                handler.send_json(502, {"error": "dashboard_proxy_failed",
                                        "detail": str(exc)})
            except Exception:  # noqa: BLE001
                pass
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass

    # -- idle watcher -------------------------------------------------------

    def idle_watcher(self) -> None:
        while True:
            time.sleep(self.poll_interval)
            st = self.state
            with st.lock:
                if st.mode != "up":
                    continue
                if st.active_conns > 0 or st.active_runs:
                    continue
                idle_for = time.time() - st.last_activity
                ttl = float(self.settings.get("idle_ttl_minutes") or 0) * 60.0
                if ttl <= 0:
                    continue
                if idle_for >= ttl:
                    self._do_idle_stop()

    def health_watcher(self) -> None:
        """If the upstream dies while we think it is up, mark down so the next
        request re-spawns it. Without this, a crashed/restarted gateway would
        leave the PWA with proxy errors and no auto-recovery."""
        misses = 0
        while True:
            time.sleep(max(5.0, self.poll_interval))
            with self.state.lock:
                if self.state.mode != "up":
                    misses = 0
                    continue
            if self._readiness_ok():
                misses = 0
                continue
            misses += 1
            if misses >= 2:
                log.warning("upstream unhealthy for %d checks — marking down "
                            "(next request will restart Hermes)", misses)
                with self.state.lock:
                    self.state.mode = "down"
                    self.state.health_up = False
                    self.state.boot_ok_at = None
                    self.state.active_runs = {}
                    self.state.child = None
                misses = 0

    def _do_idle_stop(self) -> None:
        threading.Thread(target=self.stop_hermes, daemon=True,
                         name="idle-stop").start()

    # -- proxy --------------------------------------------------------------

    def proxy(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        st = self.state
        st.touch_inbound()
        with st.lock:
            active = st.mode == "up"
        if not active:
            self.start_hermes()
            handler.send_json(503, {"error": "hermes_starting",
                                    "message": "Hermes is booting; retry shortly",
                                    "retry_after": 3})
            return

        key = self.settings.get("hermes_api_key") or ""
        if not key:
            handler.send_json(502, {"error": "no_api_key",
                                    "message": "supervisor settings: hermes_api_key missing"})
            return

        # Read the request body ONCE; retries reuse it (rfile cannot be re-read).
        body = handler.rfile.read(int(handler.headers.get("Content-Length", "0") or 0)) \
            if handler.command in ("POST", "PUT", "PATCH") else None

        for attempt in range(3):
            conn: Optional[HTTPConnection] = None
            try:
                conn = HTTPConnection(self.upstream["host"], self.upstream["port"],
                                      timeout=300)
                headers = {k: v for k, v in handler.headers.items()
                           if k.lower() not in ("host", "authorization",
                                                "connection", "transfer-encoding",
                                                "content-length")}
                headers["Authorization"] = f"Bearer {key}"
                headers["Host"] = f"{self.upstream['host']}:{self.upstream['port']}"
                conn.request(handler.command, path, body=body, headers=headers)
                resp = conn.getresponse()

                with st.lock:
                    st.active_conns += 1
                try:
                    self._relay_response(handler, resp, path)
                finally:
                    with st.lock:
                        st.active_conns = max(0, st.active_conns - 1)
                return
            except Exception as exc:  # noqa: BLE001
                log.warning("proxy error %s %s (attempt %d): %s",
                            handler.command, path, attempt + 1, exc)
                msg = str(exc)
                transient = ("Remote end closed" in msg or "Connection aborted" in msg
                             or "ConnectionReset" in msg or "connection reset" in msg.lower()
                             or "Connection refused" in msg)
                if attempt < 2 and transient:
                    log.info("transient upstream failure — waiting for restart, then retrying")
                    # The gateway may have hard-crashed (native abort). Wake/restart
                    # it and wait for genuine readiness before the next attempt.
                    with st.lock:
                        was_up = st.mode == "up"
                    if not was_up:
                        self.start_hermes()
                    self._wait_ready(max_wait=90.0)
                    time.sleep(1.0)
                    continue
                try:
                    with st.lock:
                        recent_boot = (st.boot_ok_at is not None
                                       and time.time() - st.boot_ok_at < 30)
                    if recent_boot or msg == "":
                        # cold-start window (or a bare close): soft-fail so the
                        # UI says "boot in progress" instead of a raw error.
                        handler.send_json(503, {"error": "hermes_starting",
                                                "message": "Hermes is booting; retry shortly",
                                                "retry_after": 3})
                    else:
                        handler.send_json(502, {"error": "proxy_failed",
                                                "detail": msg})
                except Exception:  # noqa: BLE001
                    pass
                return
            finally:
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:  # noqa: BLE001
                        pass

    def _relay_response(self, handler: BaseHTTPRequestHandler, resp, path: str) -> None:
        if resp.status >= 400:
            log.warning("upstream %s %s -> HTTP %s (client sees %s)",
                        handler.command, path, resp.status,
                        "403-bodiless-forbidden" if resp.status == 403 else resp.status)
        # POST /v1/runs: small JSON 202 with the run id — drain fully to parse it.
        if handler.command == "POST" and path.startswith("/v1/runs"):
            body = resp.read()
            if resp.status in (200, 201, 202):
                try:
                    data = json.loads(body or b"{}")
                    rid = data.get("run_id") or data.get("id")
                    if rid:
                        self.note_run_created(str(rid))
                except Exception:  # noqa: BLE001
                    pass
            handler.send_response_only(resp.status, resp.reason or "")
            for k, v in resp.getheaders():
                if k.lower() in ("transfer-encoding", "content-length",
                                 "connection", "keep-alive", "upgrade"):
                    continue
                handler.send_header(k, v)
            handler.send_header("Connection", "close")
            handler.end_headers()
            handler.wfile.write(body)
            handler.wfile.flush()
            return

        # Everything else (chat completions strings, /v1/runs events SSE, ...):
        # forward headers immediately, then stream the body chunks live.
        chunked = getattr(resp, "chunked", False)
        handler.send_response_only(resp.status, resp.reason or "")
        for k, v in resp.getheaders():
            if k.lower() in ("transfer-encoding", "content-length",
                             "connection", "keep-alive", "upgrade"):
                continue
            handler.send_header(k, v)
        if chunked:
            handler.send_header("Transfer-Encoding", "chunked")
        else:
            length = getattr(resp, "length", None)
            if length is not None and length >= 0:
                handler.send_header("Content-Length", str(length))
        handler.send_header("Connection", "close")
        handler.end_headers()
        try:
            if chunked:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    handler.wfile.write(b"%x\r\n" % len(chunk))
                    handler.wfile.write(chunk)
                    handler.wfile.write(b"\r\n")
                    handler.wfile.flush()
                handler.wfile.write(b"0\r\n\r\n")
                handler.wfile.flush()
            else:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                    handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            log.info("client disconnected mid-stream")


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "HermesChatSupervisor/0.1"

    sup: Supervisor = None  # type: ignore[assignment]

    def log_message(self, fmt, *args):  # quiet access log noise
        log.debug("http " + fmt, *args)

    def send_json(self, status: int, payload: Dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

    def _serve_static(self, path: str) -> None:
        root = self.sup.web_root
        clean = urllib.parse.unquote(path).lstrip("/")
        if not clean:
            clean = "index.html"
        target = (root / clean).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            target = root / "index.html"
        if not target.is_file():
            if clean and Path(clean).suffix:
                self.send_error(404)
                return
            target = root / "index.html"
        if not target.is_file():
            self.send_json(503, {"error": "web_ui_missing",
                                 "message": f"static UI not built at {root}"})
            return
        try:
            data = target.read_bytes()
        except OSError:
            self.send_error(403)
            return
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript",
            ".css": "text/css",
            ".json": "application/json",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".webmanifest": "application/manifest+json",
        }.get(target.suffix.lower(), "application/octet-stream")
        cache = "public, max-age=31536000, immutable" \
            if clean.startswith("assets/") else "no-cache"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

    # -- routing -------------------------------------------------------------

    def do_GET(self):
        self._route()

    def do_POST(self):
        self._route()

    def do_PUT(self):
        self._route()

    def do_DELETE(self):
        self._route()

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def _route(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        qs = parsed.query
        try:
            if path == "/api/supervisor/status":
                self.send_json(200, self.sup.state.snapshot())
                return
            if path == "/api/supervisor/settings":
                if self.command == "GET":
                    st = self.sup.settings
                    self.send_json(200, {
                        "idle_ttl_minutes": st.get("idle_ttl_minutes"),
                        "max_task_minutes": st.get("max_task_minutes"),
                        "api_key_set": bool(st.get("hermes_api_key")),
                    })
                    return
                if self.command == "PUT":
                    raw = self.rfile.read(int(self.headers.get("Content-Length", "0") or 0))
                    try:
                        patch = json.loads(raw or b"{}")
                    except Exception:  # noqa: BLE001
                        self.send_json(400, {"error": "invalid_json"})
                        return
                    allowed = {k: patch[k] for k in ("idle_ttl_minutes", "max_task_minutes")
                               if k in patch}
                    # sanitize
                    for k in ("idle_ttl_minutes", "max_task_minutes"):
                        if k in allowed:
                            try:
                                v = max(1 if k == "idle_ttl_minutes" else 0,
                                        int(allowed[k]))
                                allowed[k] = v
                            except (TypeError, ValueError):
                                allowed.pop(k, None)
                    snap = self.sup.settings.put(allowed) if allowed else \
                        self.sup.settings.data
                    # Mirror the GET shape (and never leak hermes_api_key to the
                    # browser): idle/max + api_key_set only.
                    self.send_json(200, {
                        "idle_ttl_minutes": snap.get("idle_ttl_minutes"),
                        "max_task_minutes": snap.get("max_task_minutes"),
                        "api_key_set": bool(snap.get("hermes_api_key")),
                    })
                    return
            if path == "/api/supervisor/start":
                ok = self.sup.start_hermes()
                self.send_json(200 if ok else 500,
                               self.sup.state.snapshot())
                return
            if path == "/api/supervisor/stop":
                threading.Thread(target=self.sup.stop_hermes,
                                 args=(True,), daemon=True,
                                 name="manual-stop").start()
                self.send_json(200, self.sup.state.snapshot())
                return
            if path.startswith(("/v1/", "/health")):
                self.sup.proxy(self, path + (("?" + qs) if qs else ""))
                return
            if path in ("/api/model/options", "/api/model/options/"):
                # Hermes's authenticated model picker payload — proxy so the
                # PWA can build a model picker without holding the API key.
                self.sup.proxy(self, path + (("?" + qs) if qs else ""))
                return
            if path.startswith("/api/"):
                self.send_json(404, {"error": "unknown_supervisor_api"})
                return
            self._serve_static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            log.exception("route error")
            try:
                self.send_json(500, {"error": "internal", "detail": str(exc)})
            except Exception:  # noqa: BLE001
                pass


class DashboardHandler(BaseHTTPRequestHandler):
    """Second listener (default 9191) that proxies the Hermes web dashboard
    with a forced-Japanese locale injection (see Supervisor.proxy_dashboard)."""

    protocol_version = "HTTP/1.1"
    server_version = "HermesChatSupervisor/0.1"

    sup: Supervisor = None  # type: ignore[assignment]

    def log_message(self, fmt, *args):  # noqa: N802 - quiet access log
        log.debug("dash " + fmt, *args)

    def send_json(self, status: int, payload: Dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()

    def _route(self) -> None:
        parsed = urllib.parse.urlsplit(self.path)
        try:
            self.sup.proxy_dashboard(
                self, parsed.path + (("?" + parsed.query) if parsed.query else ""))
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:  # noqa: BLE001
            log.exception("dashboard route error")
            try:
                self.send_json(500, {"error": "internal", "detail": str(exc)})
            except Exception:  # noqa: BLE001
                pass

    do_GET = _route
    do_POST = _route
    do_PUT = _route
    do_DELETE = _route

    def do_OPTIONS(self) -> None:  # noqa: N802
        self.send_response(204)
        self.end_headers()


def main() -> int:
    upstream_raw = os.environ.get("HERMES_API_URL", "http://127.0.0.1:8643")
    u = urllib.parse.urlsplit(upstream_raw)
    upstream = {"host": u.hostname or "127.0.0.1", "port": u.port or 8643}

    settings_path = Path(os.environ.get("HERMES_CHAT_SETTINGS", str(HERE / "settings.json")))
    settings = SettingsStore(settings_path)
    state = State()

    web_root = Path(os.environ.get("WEB_ROOT", str(HERE.parent / "web" / "dist"))).resolve()
    start_cmd = os.environ.get("HERMES_START_CMD", "hermes gateway run").split()
    env = dict(os.environ)
    if os.environ.get("HERMES_HOME"):
        env["HERMES_HOME"] = os.environ["HERMES_HOME"]

    sup = Supervisor(settings, state, upstream, web_root, start_cmd, env)
    Handler.sup = sup

    port = int(os.environ.get("SUPERVISOR_PORT", "8642"))
    host = os.environ.get("SUPERVISOR_HOST", "127.0.0.1")
    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True

    threading.Thread(target=sup.idle_watcher, daemon=True,
                     name="idle-watcher").start()
    threading.Thread(target=sup.health_watcher, daemon=True,
                     name="health-watcher").start()

    # Forced-Japanese dashboard proxy listener (admin pages only).
    dash_raw = os.environ.get("DASHBOARD_API_URL", "http://127.0.0.1:9119")
    du = urllib.parse.urlsplit(dash_raw)
    sup.dashboard = {"host": du.hostname or "127.0.0.1", "port": du.port or 9119}
    dash_port = int(os.environ.get("DASHBOARD_PROXY_PORT", "9191"))
    try:
        dashd = ThreadingHTTPServer(("127.0.0.1", dash_port), DashboardHandler)
        dashd.daemon_threads = True
        DashboardHandler.sup = sup
        threading.Thread(target=dashd.serve_forever, daemon=True,
                         name="dash-proxy").start()
        log.info("dashboard proxy (forced ja) on http://127.0.0.1:%s -> %s",
                 dash_port, dash_raw)
    except OSError as exc:
        log.warning("dashboard proxy not started on %s: %s", dash_port, exc)
    log.info("Hermes Chat supervisor listening on http://%s:%s "
             "(upstream %s, web %s)", host, port, upstream_raw, web_root)
    log.info("idle TTL=%s min, start cmd=%s", settings.get("idle_ttl_minutes"),
             " ".join(start_cmd))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())