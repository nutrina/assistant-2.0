import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { Server as HttpServer } from "node:http";
import { once } from "node:events";
import { call, local, rpc, signUp } from "../rpc/supabase.ts";

const MAIN = new URL("../../src/dictate/main.ts", import.meta.url).pathname;
const TRANSCRIPT = "shipped the log";

type SttHit = { authorization?: string; model: string; fileType: string; fileSize: number };

let page: { proc: ChildProcess; base: string };
let stt: HttpServer;
const sttHits: SttHit[] = [];

function startStt(): Promise<string> {
  stt = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c);
    const form = await new Request("http://stt/", {
      method: "POST",
      headers: { "content-type": req.headers["content-type"] ?? "" },
      body: Buffer.concat(chunks),
    }).formData();
    const file = form.get("file") as File;
    sttHits.push({
      authorization: req.headers.authorization,
      model: String(form.get("model")),
      fileType: file.type,
      fileSize: file.size,
    });
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: TRANSCRIPT }));
  });
  stt.listen(0, "127.0.0.1");
  return once(stt, "listening").then(() => {
    const addr = stt.address() as { port: number };
    return `http://127.0.0.1:${addr.port}/v1/audio/transcriptions`;
  });
}

function startPage(env: Record<string, string | undefined>): Promise<{ proc: ChildProcess; base: string }> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN], {
    env: { PATH: process.env.PATH, PRA_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/listening on (http:\S+?)\/?\s/);
      if (m) resolve({ proc, base: m[1] });
    });
    proc.on("exit", (code) => reject(new Error(`page exited ${code}: ${err}`)));
  });
}

function dictate(token?: string, audio = Buffer.from("RIFF fake webm audio")): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "audio/webm" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${page.base}/dictate`, { method: "POST", headers, body: audio });
}

before(async () => {
  const { url, anonKey } = local();
  const sttUrl = await startStt();
  page = await startPage({ SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, PRA_STT_URL: sttUrl, PRA_STT_KEY: "fixture-key" });
});

after(async () => {
  page?.proc.kill("SIGTERM");
  if (page) await once(page.proc, "exit");
  stt?.close();
});

test("GET /health returns 200 and ok", async () => {
  const res = await fetch(`${page.base}/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
});

test("the page and its assets are served, and nothing outside web/", async () => {
  const html = await fetch(`${page.base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /text\/html/);
  assert.match(await html.text(), /id="sign-in-form"/);
  for (const asset of ["/app.js", "/app.css", "/manifest.webmanifest"]) {
    const res = await fetch(`${page.base}${asset}`);
    assert.equal(res.status, 200, asset);
    await res.body?.cancel();
  }
  const escape = await fetch(`${page.base}/../package.json`);
  assert.equal(escape.status, 404);
  await escape.body?.cancel();
});

test("GET /config.json hands the page the local API URL and anon key", async () => {
  const { url, anonKey } = local();
  const res = await fetch(`${page.base}/config.json`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { supabaseUrl: url, anonKey });
});

test("POST /dictate without a token is 401 and never reaches the speech API", async () => {
  const before = sttHits.length;
  const res = await dictate();
  assert.equal(res.status, 401);
  await res.body?.cancel();
  assert.equal(sttHits.length, before);
});

test("POST /dictate with an invalid token is 401 and never reaches the speech API", async () => {
  const before = sttHits.length;
  for (const token of ["not-a-jwt", local().anonKey]) {
    const res = await dictate(token);
    assert.equal(res.status, 401, token);
    await res.body?.cancel();
  }
  assert.equal(sttHits.length, before);
});

test("POST /dictate with a valid token returns the transcript, which write_retro saves", async () => {
  const user = await signUp();
  const before = sttHits.length;
  const res = await dictate(user.accessToken);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: TRANSCRIPT });
  assert.equal(sttHits.length, before + 1);
  const hit = sttHits.at(-1)!;
  assert.equal(hit.model, "whisper-large-v3-turbo");
  assert.equal(hit.fileType, "audio/webm");
  assert.ok(hit.fileSize > 0);
  assert.equal(hit.authorization, "Bearer fixture-key");

  await call(user, "write_retro", { kind: "daily", body: TRANSCRIPT });
  const day = await call(user, "get_period", { period: "day" });
  assert.equal(day.retro.body, TRANSCRIPT);
  assert.equal(day.retro.phase, "submitted");
});

test("the quick log through /rpc: a log shows in today's list, a blank value adds no row", async () => {
  const user = await signUp();
  const type = await call(user, "create_activity_type", { name: "push-ups", unit: "reps" });
  const day = await call(user, "get_period", { period: "day" });

  await call(user, "log_activity", { activityTypeId: type.id, value: 12 });
  const blank = await rpc(user, "log_activity", { activityTypeId: type.id, value: null });
  assert.notEqual(blank.status, 200);
  assert.equal(blank.body.message, "invalid_value");

  const today = await call(user, "list_activity_logs", { fromDate: day.date, toDate: day.date });
  assert.equal(today.length, 1);
  assert.equal(today[0].activityName, "push-ups");
  assert.equal(Number(today[0].value), 12);
});

test("a hard daily goal shows the sum of the day's logs against its target", async () => {
  const user = await signUp();
  const type = await call(user, "create_activity_type", { name: "push-ups", unit: "reps" });
  const goal = await call(user, "create_goal", {
    goalType: "hard",
    name: "daily push-ups",
    activityTypeId: type.id,
    targetValue: 20,
    period: "day",
  });
  await call(user, "log_activity", { activityTypeId: type.id, value: 10 });
  await call(user, "log_activity", { activityTypeId: type.id, value: 5 });
  const day = await call(user, "get_period", { period: "day" });
  const shown = day.goals.find((g: any) => g.id === goal.id);
  assert.equal(Number(shown.sum), 15);
  assert.equal(Number(shown.targetValue), 20);
});

test("the page refuses to start without the Supabase URL or anon key", async () => {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN], {
    env: { PATH: process.env.PATH, PRA_PORT: "0", SUPABASE_URL: local().url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  const [code] = await once(proc, "exit");
  assert.notEqual(code, 0);
  assert.match(err, /missing_auth/);
});
