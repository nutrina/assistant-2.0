// One process for the container: GET /health, the page in web/, GET /config.json, POST /dictate,
// and MCP streamable HTTP at POST /mcp, all on one port. Postgres, Auth, and PostgREST stay on
// Supabase. src/mcp/main.ts and src/dictate/main.ts listen on import, so neither is imported here.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { TOOLS, UserSession, callTool, isTool } from "./mcp/tools.ts";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const MAX_MCP_BODY_BYTES = 1_000_000;
const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const WEB_DIR = new URL("../web/", import.meta.url);

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
};

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const anonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.PRA_EMAIL;
const password = process.env.PRA_PASSWORD;
if (!supabaseUrl || !anonKey || !email || !password) {
  console.error("missing_auth");
  process.exit(1);
}

const user = new UserSession({ url: supabaseUrl, anonKey, email, password });
// The browser may reach Supabase at a different address than this process does (in a container,
// host.docker.internal is not resolvable from the host's browser).
const publicSupabaseUrl = process.env.PRA_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") || supabaseUrl;
const sttUrl = process.env.PRA_STT_URL || GROQ_URL;
const sttKey = process.env.PRA_STT_URL ? process.env.PRA_STT_KEY : process.env.GROQ_API_KEY;
const port = Number(process.env.PRA_PORT ?? 8787);
const host = process.env.PRA_HOST ?? "127.0.0.1";

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res
    .writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers })
    .end(JSON.stringify(body));
}

async function readLimited(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---- page and dictation ----

function bearer(req: IncomingMessage): string | undefined {
  return req.headers.authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

// Supabase Auth is the judge of the token: /auth/v1/user answers 200 only for a live user session.
async function tokenValid(token: string): Promise<boolean> {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey!, Authorization: `Bearer ${token}` },
  });
  await res.body?.cancel();
  return res.ok;
}

function extensionFor(type: string): string {
  if (type.includes("webm")) return "webm";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mp4") || type.includes("m4a") || type.includes("aac")) return "m4a";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("wav")) return "wav";
  return "webm";
}

async function transcribe(audio: Buffer, type: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `retro.${extensionFor(type)}`);
  form.append("model", GROQ_MODEL);
  form.append("response_format", "json");
  const headers: Record<string, string> = {};
  if (sttKey) headers.Authorization = `Bearer ${sttKey}`;
  const res = await fetch(sttUrl, { method: "POST", headers, body: form });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.text !== "string") throw new Error(`speech API failed (${res.status})`);
  return body.text.trim();
}

async function handleDictate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = bearer(req);
  if (!token || !(await tokenValid(token))) {
    req.resume();
    return json(res, 401, { error: "unauthorized" });
  }
  if (!process.env.PRA_STT_URL && !sttKey) {
    req.resume();
    return json(res, 503, { error: "stt_unconfigured" });
  }
  let audio: Buffer;
  try {
    audio = await readLimited(req, MAX_AUDIO_BYTES);
  } catch {
    return json(res, 413, { error: "audio_too_large" });
  }
  if (audio.length === 0) return json(res, 400, { error: "no_audio" });
  const type = (req.headers["content-type"] ?? "audio/webm").split(";")[0].trim();
  try {
    json(res, 200, { text: await transcribe(audio, type) });
  } catch (err) {
    console.error("dictate failed:", (err as Error).message);
    json(res, 502, { error: "stt_failed" });
  }
}

async function handleStatic(path: string, res: ServerResponse): Promise<void> {
  const entry = STATIC[path];
  if (!entry) return json(res, 404, { error: "not_found" });
  const body = await readFile(new URL(entry.file, WEB_DIR));
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" }).end(body);
}

// ---- MCP ----

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

class RpcFailure extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

// Browsers send Origin; a page on another site must not drive this user's tools (DNS rebinding).
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return LOCAL_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

async function dispatch(msg: JsonRpcRequest): Promise<unknown> {
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "personal-retro-assistant", version: "0.1.0" },
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = msg.params?.name;
      if (!isTool(name)) throw new RpcFailure(-32602, `unknown tool: ${String(name)}`);
      return callTool(user, name, msg.params?.arguments ?? {});
    }
    default:
      throw new RpcFailure(-32601, `method not found: ${msg.method}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse((await readLimited(req, MAX_MCP_BODY_BYTES)).toString("utf8"));
  } catch (err) {
    const tooLarge = (err as Error).message === "body_too_large";
    return json(res, tooLarge ? 413 : 400, rpcError(null, -32700, tooLarge ? "body too large" : "parse error"));
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return json(res, 400, rpcError(null, -32600, "invalid request"));
  }
  // Notifications carry no id and get no response body.
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  try {
    json(res, 200, { jsonrpc: "2.0", id: msg.id, result: await dispatch(msg) });
  } catch (err) {
    if (!(err instanceof RpcFailure)) throw err;
    json(res, 200, rpcError(msg.id, err.code, err.message));
  }
}

// ---- server ----

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  let work: Promise<void>;
  if (path === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  } else if (path === "/mcp") {
    if (!originAllowed(req)) return json(res, 403, rpcError(null, -32000, "origin not allowed"));
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    work = handleMcp(req, res);
  } else if (path === "/config.json" && req.method === "GET") {
    return json(res, 200, { supabaseUrl: publicSupabaseUrl, anonKey });
  } else if (path === "/dictate" && req.method === "POST") {
    work = handleDictate(req, res);
  } else if (req.method === "GET" || req.method === "HEAD") {
    work = handleStatic(path, res);
  } else {
    return json(res, 405, { error: "method_not_allowed" });
  }
  work.catch((err) => {
    console.error("request failed:", err);
    if (!res.headersSent) json(res, 500, { error: "internal" });
  });
});

server.listen(port, host, () => {
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(`listening on http://${host}:${bound}/`);
  // Sign in up front so the first tool call is warm. A failure is reported per call, not fatal.
  user.accessToken().then(
    () => console.log("signed in"),
    (err: Error) => console.error(`auth error: ${err.message}`),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
