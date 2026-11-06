// Serves the page in web/ and POST /dictate. The page talks to Supabase Auth and PostgREST /rpc
// itself; this process only hands it the public API URL and anon key, and turns audio into text.
// /dictate checks the caller's Supabase access token before any audio leaves this process.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const WEB_DIR = new URL("../../web/", import.meta.url);

const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json" },
};

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, "");
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !anonKey) {
  console.error("missing_auth");
  process.exit(1);
}

const sttUrl = process.env.PRA_STT_URL || GROQ_URL;
const sttKey = process.env.PRA_STT_URL ? process.env.PRA_STT_KEY : process.env.GROQ_API_KEY;
const port = Number(process.env.PRA_PORT ?? 8787);
const host = process.env.PRA_HOST ?? "127.0.0.1";

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string | undefined {
  const m = req.headers.authorization?.match(/^Bearer\s+(\S+)$/i);
  return m?.[1];
}

// Supabase Auth is the judge of the token: /auth/v1/user answers 200 only for a live user session.
async function tokenValid(token: string): Promise<boolean> {
  const res = await fetch(`${supabaseUrl}/auth/v1/user`, {
    headers: { apikey: anonKey!, Authorization: `Bearer ${token}` },
  });
  await res.body?.cancel();
  return res.ok;
}

async function readAudio(req: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw new Error("audio_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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
  if (!res.ok || typeof body.text !== "string") {
    throw new Error(`speech API failed (${res.status})`);
  }
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
    audio = await readAudio(req);
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

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const route = `${req.method} ${path}`;
  let work: Promise<void>;
  if (route === "GET /health") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  } else if (route === "GET /config.json") {
    return json(res, 200, { supabaseUrl, anonKey });
  } else if (route === "POST /dictate") {
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
  console.log(`page listening on http://${host}:${bound}/`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
