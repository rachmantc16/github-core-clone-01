// Entry point for the github-core-clone-01 forge.
//
// This process has one job: show up for the trial harness (the "env"), serve
// the forge while the trial runs, and leave cleanly when the trial is over.
// The env owns the trial; this process only follows its lead:
//
//   1. Find the env. MAKEFUN_ENV_URL names its origin. With no env to talk
//      to, there is nothing useful to do, so the process stops at once
//      with exit code 1.
//   2. Start the forge from app.ts on a free port. By default the kernel
//      picks the port (ephemeral). ENTRY_PORT pins one port, and
//      ENTRY_PORT_MIN / ENTRY_PORT_MAX give a range to try in order —
//      handy for local runs. Port 8080 is never taken: the env lives there.
//   3. Announce the port to the env with POST /register. A 200 means the
//      env accepted it; a 409 means some other entry got there first, in
//      which case this process just waits with the rest. Other answers and
//      network failures are retried with a growing pause, because the env
//      may still be starting — except 400 and 405, which say the request
//      itself is wrong and stop the process.
//   4. Ask GET /done over and over until the env answers {"done": true}.
//      The env answers right away, so this is polling with a small pause,
//      not one long-held request.
//   5. Close the forge and exit 0.
//
// SIGINT and SIGTERM are caught as well: the forge is closed (waiting at
// most ENTRY_SHUTDOWN_TIMEOUT_MS for connections to drain) and the process
// exits 0, so a local run can be stopped without a fuss.
//
// Nothing is imported here except the forge itself; the rest is the Node
// surface available as globals (fetch, process, timers).

import { createApp } from "./app.ts";

const APP_NAME = "github-core-clone-01";
const APP_VERSION = "1.1.0";

type ForgeServer = ReturnType<typeof createApp>;

interface EntryConfig {
  envUrl: string;
  host: string;
  port: number;
  portMin: number;
  portMax: number;
  requestTimeoutMs: number;
  retryBaseMs: number;
  retryCapMs: number;
  shutdownTimeoutMs: number;
}

function readEnvText(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(): EntryConfig {
  return {
    envUrl: readEnvText("MAKEFUN_ENV_URL", "").replace(/\/+$/, ""),
    host: readEnvText("ENTRY_HOST", ""),
    port: readEnvInt("ENTRY_PORT", 0),
    portMin: readEnvInt("ENTRY_PORT_MIN", 0),
    portMax: readEnvInt("ENTRY_PORT_MAX", 0),
    requestTimeoutMs: readEnvInt("MAKEFUN_REQUEST_TIMEOUT_MS", 30_000),
    retryBaseMs: readEnvInt("ENTRY_RETRY_BASE_MS", 250),
    retryCapMs: readEnvInt("ENTRY_RETRY_CAP_MS", 2_000),
    shutdownTimeoutMs: readEnvInt("ENTRY_SHUTDOWN_TIMEOUT_MS", 5_000),
  };
}

function log(line: string): void {
  process.stdout.write(`[entry] ${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function backoffMs(attempt: number, base: number, cap: number): number {
  let wait = base;
  for (let i = 0; i < attempt && wait < cap; i += 1) {
    wait = Math.min(cap, wait * 2);
  }
  return wait;
}

/** A fetch that never throws: network trouble comes back as null instead. */
function tryFetch(input: string, init: RequestInit): Promise<Response | null> {
  return fetch(input, init).then(
    (res) => res,
    () => null,
  );
}

function listenOnce(server: ForgeServer, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("the forge bound to something that is not a TCP port"));
        return;
      }
      resolve(addr.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      if (host === "") server.listen(port);
      else server.listen(port, host);
    } catch (err) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(err as Error);
    }
  });
}

interface BoundForge {
  server: ForgeServer;
  port: number;
}

/**
 * Start the forge on the configured port: one pinned port first, then the
 * configured range in order, then an ephemeral port when nothing is pinned.
 * Port 8080 is skipped outright — that is where the env listens.
 */
async function bindForge(cfg: EntryConfig): Promise<BoundForge> {
  const server = createApp();
  const candidates: number[] = [];
  if (cfg.port > 0) candidates.push(cfg.port);
  if (cfg.portMin > 0 && cfg.portMax >= cfg.portMin) {
    for (let p = cfg.portMin; p <= cfg.portMax; p += 1) candidates.push(p);
  }
  if (candidates.length === 0) candidates.push(0);
  let lastFailure: unknown = null;
  for (const candidate of candidates) {
    if (candidate === 8080) continue;
    try {
      const port = await listenOnce(server, cfg.host, candidate);
      return { server, port };
    } catch (err) {
      lastFailure = err;
    }
  }
  if (lastFailure instanceof Error) throw lastFailure;
  throw new Error("no usable port was configured for the forge");
}

/** Close the server, waiting for connections to drain up to timeoutMs. */
function closeForge(server: ForgeServer, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      server.closeAllConnections();
      resolve();
    }, timeoutMs);
    server.close(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Set by the signal handler; the register/done loops check it between tries. */
let stopRequested = false;

/**
 * Tell the env the bound port. Returns true once the env has the port
 * (200, or 409 when another entry registered first); returns false when a
 * signal asked the process to stop instead. A 400/405 means the request
 * itself is wrong and throws; anything else is retried.
 */
async function registerWithEnv(cfg: EntryConfig, port: number): Promise<boolean> {
  const payload = JSON.stringify({ port });
  for (let attempt = 0; ; attempt += 1) {
    if (stopRequested) return false;
    const res = await tryFetch(`${cfg.envUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    if (res === null) {
      await sleep(backoffMs(attempt, cfg.retryBaseMs, cfg.retryCapMs));
      continue;
    }
    const accepted = res.status === 200 || res.status === 409;
    if (accepted) return true;
    const contractError = res.status === 400 || res.status === 405;
    if (contractError) {
      const detail = await res.text();
      throw new Error(`the env refused the register call (HTTP ${res.status}): ${detail}`);
    }
    await sleep(backoffMs(attempt, cfg.retryBaseMs, cfg.retryCapMs));
  }
}

/** Read a response body as JSON; a garbled body comes back as null. */
function parseJsonBody(res: Response): Promise<unknown | null> {
  return res.json().then(
    (value) => value as unknown,
    () => null,
  );
}

/**
 * Poll GET /done until the env says the trial is over. Returns true on
 * {"done": true}; returns false when a signal asked the process to stop.
 * A missing or garbled answer just means "not done yet".
 */
async function waitUntilDone(cfg: EntryConfig): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    if (stopRequested) return false;
    const res = await tryFetch(`${cfg.envUrl}/done`, {
      signal: AbortSignal.timeout(cfg.requestTimeoutMs),
    });
    if (res !== null && res.ok) {
      const payload = await parseJsonBody(res);
      const finished =
        payload !== null &&
        typeof payload === "object" &&
        (payload as { done?: unknown }).done === true;
      if (finished) return true;
    }
    await sleep(backoffMs(attempt, cfg.retryBaseMs, cfg.retryCapMs));
  }
}

async function run(): Promise<number> {
  const cfg = loadConfig();
  if (cfg.envUrl === "") {
    process.stderr.write("[entry] MAKEFUN_ENV_URL is missing, so there is no env to register with\n");
    return 1;
  }

  const { server, port } = await bindForge(cfg);
  server.on("error", (err: Error) => {
    process.stderr.write(`[entry] forge server error: ${err.message}\n`);
  });
  const bound = server.address();
  const where =
    bound !== null && typeof bound === "object"
      ? `${bound.address}:${bound.port}`
      : `port ${port}`;
  log(`${APP_NAME} v${APP_VERSION} — forge up on ${where}`);

  const onSignal = (signal: string): void => {
    if (stopRequested) return;
    stopRequested = true;
    log(`got ${signal}; closing the forge`);
    void closeForge(server, cfg.shutdownTimeoutMs).then(() => {
      log("forge closed after signal");
    });
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  const registered = await registerWithEnv(cfg, port);
  if (!registered) {
    log("stopped before registering; exiting");
    return 0;
  }
  log(`port ${port} registered with the env at ${cfg.envUrl}; waiting for the trial to finish`);

  const done = await waitUntilDone(cfg);
  if (!done) {
    log("stopped while waiting; exiting");
    return 0;
  }
  log("the env says the trial is done; closing the forge");
  await closeForge(server, cfg.shutdownTimeoutMs);
  log("forge closed; exiting");
  return 0;
}

const EXIT_FAILURE = 1;

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT_FAILURE);
  },
);
