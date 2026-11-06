import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { call, local, signUp } from "../rpc/supabase.ts";
import { UserSession, callTool } from "../../src/mcp/tools.ts";
import type { Session } from "../rpc/supabase.ts";

const MAIN = new URL("../../src/mcp/main.ts", import.meta.url).pathname;

type Server = { proc: ChildProcess; endpoint: string; stderr: () => string };
type ToolCall = { isError: boolean; json: any };

const servers: Server[] = [];

function startServer(env: Record<string, string | undefined>): Promise<Server> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN], {
    env: { PATH: process.env.PATH, PRA_MCP_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  proc.stderr!.on("data", (d) => (err += d));
  return new Promise((resolve, reject) => {
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/listening on (http:\S+)/);
      if (m) {
        const server = { proc, endpoint: m[1], stderr: () => err };
        servers.push(server);
        resolve(server);
      }
    });
    proc.on("exit", (code) => reject(new Error(`server exited ${code}: ${err}`)));
  });
}

let nextId = 1;

async function mcp(server: Server, method: string, params?: unknown): Promise<any> {
  const res = await fetch(server.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function connect(server: Server): Promise<void> {
  const init = await mcp(server, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "pra-test", version: "0" },
  });
  assert.equal(init.protocolVersion, "2025-06-18");
  const ack = await fetch(server.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(ack.status, 202);
}

async function tool(server: Server, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  const result = await mcp(server, "tools/call", { name, arguments: args });
  return { isError: result.isError === true, json: JSON.parse(result.content[0].text) };
}

async function ok(server: Server, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { isError, json } = await tool(server, name, args);
  if (isError) throw new Error(`${name} failed: ${JSON.stringify(json)}`);
  return json;
}

function supabaseEnv(user: Session, password = user.password) {
  const { url, anonKey } = local();
  return { SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, PRA_EMAIL: user.email, PRA_PASSWORD: password };
}

let user: Session;
let server: Server;

before(async () => {
  user = await signUp();
  server = await startServer(supabaseEnv(user));
  await connect(server);
});

after(() => {
  for (const s of servers) s.proc.kill();
});

function sumFor(period: any, activityTypeId: string): number {
  return Number(period.activities.find((a: any) => a.activityTypeId === activityTypeId)?.sum ?? 0);
}

test("tools/list offers one tool per function", async () => {
  const { tools } = await mcp(server, "tools/list");

  assert.deepEqual(tools.map((t: any) => t.name).sort(), [
    "add_soft_goal_checkin",
    "create_activity_type",
    "create_category",
    "create_goal",
    "get_period",
    "list_activity_logs",
    "list_activity_types",
    "list_categories",
    "list_goals",
    "log_activity",
    "set_goal_active",
    "set_retro_judgment",
    "set_soft_goal_status",
    "set_timezone",
    "write_retro",
  ]);
});

test("get_period returns the sum of a value just logged through MCP", async () => {
  const type = await ok(server, "create_activity_type", { name: "push-ups", unit: "reps" });
  await ok(server, "log_activity", { activityTypeId: type.id, value: 10, loggedOn: "2026-11-06" });

  const period = await ok(server, "get_period", { period: "day", date: "2026-11-06" });

  assert.equal(sumFor(period, type.id), 10);
});

test("each log_activity call appends and the week sums them", async () => {
  const type = await ok(server, "create_activity_type", { name: "pull-ups", unit: "reps" });
  await ok(server, "log_activity", { activityTypeId: type.id, value: 4, loggedOn: "2026-11-03" });
  await ok(server, "log_activity", { activityTypeId: type.id, value: 6, loggedOn: "2026-11-03" });
  await ok(server, "log_activity", { activityTypeId: type.id, value: 2, loggedOn: "2026-11-08" });

  const week = await ok(server, "get_period", { period: "week", date: "2026-11-05" });
  const logs = await ok(server, "list_activity_logs", { activityTypeId: type.id });

  assert.equal(sumFor(week, type.id), 12);
  assert.equal(logs.length, 3);
});

test("a hard goal with no target returns invalid_goal and is not stored", async () => {
  const type = await ok(server, "create_activity_type", { name: "squats", unit: "reps" });

  const res = await tool(server, "create_goal", { goalType: "hard", name: "no target", activityTypeId: type.id, period: "day" });
  const goals = await ok(server, "list_goals", { includeInactive: true });

  assert.equal(res.isError, true);
  assert.equal(res.json.message, "invalid_goal");
  assert.ok(!goals.some((g: any) => g.name === "no target"));
});

test("judging a retro with a blank body returns retro_open", async () => {
  const res = await tool(server, "set_retro_judgment", {
    kind: "daily",
    date: "2026-10-01",
    judgment: "fine",
    nextFocus: "more",
  });

  assert.equal(res.isError, true);
  assert.equal(res.json.message, "retro_open");
});

test("a retro written and judged over MCP reads back as judged", async () => {
  const at = { kind: "weekly", date: "2026-11-04" };
  await ok(server, "write_retro", { ...at, body: "shipped pra-1" });
  assert.equal((await ok(server, "get_period", { period: "week", date: "2026-11-04" })).retro.phase, "submitted");
  await ok(server, "set_retro_judgment", { ...at, judgment: "on track", nextFocus: "ship pra-2" });

  const { retro } = await ok(server, "get_period", { period: "week", date: "2026-11-04" });

  assert.equal(retro.phase, "judged");
  assert.equal(retro.judgment, "on track");
  assert.equal(retro.nextFocus, "ship pra-2");
});

test("a server with the wrong password returns an auth error and writes nothing", async () => {
  const victim = await signUp();
  const type = await call(victim, "create_activity_type", { name: "push-ups", unit: "reps" });
  const bad = await startServer(supabaseEnv(victim, "wrong-password"));
  await connect(bad);

  const res = await tool(bad, "log_activity", { activityTypeId: type.id, value: 99, loggedOn: "2026-11-06" });

  assert.equal(res.isError, true);
  assert.equal(res.json.error, "auth_failed");
  assert.deepEqual(await call(victim, "list_activity_logs"), []);
});

test("a refreshed session gets a new access token that still calls /rpc as the user", async () => {
  const { url, anonKey } = local();
  const session = new UserSession({ url, anonKey, email: user.email, password: user.password });

  const first = await session.accessToken();
  const refreshed = await session.accessToken(true);
  const result = await callTool(session, "set_timezone", { timezone: "UTC" });

  assert.notEqual(refreshed, first);
  assert.equal(await session.accessToken(), refreshed);
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), { timezone: "UTC" });
});

test("the server refuses to start without credentials and prints missing_auth", async () => {
  const { url, anonKey } = local();
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN], {
    env: { PATH: process.env.PATH, PRA_MCP_PORT: "0", SUPABASE_URL: url, SUPABASE_ANON_KEY: anonKey, PRA_PASSWORD: "x" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let err = "";
  proc.stderr.on("data", (d) => (err += d));
  const [code] = await once(proc, "exit");

  assert.notEqual(code, 0);
  assert.match(err, /missing_auth/);
});

test("unknown methods and tools are JSON-RPC errors, GET is not offered", async () => {
  await assert.rejects(mcp(server, "tools/call", { name: "drop_tables", arguments: {} }), /unknown tool/);
  await assert.rejects(mcp(server, "resources/list"), /method not found/);
  const get = await fetch(server.endpoint);
  assert.equal(get.status, 405);
});
