import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";

const MAIN = new URL("../../src/main.ts", import.meta.url).pathname;

// Nothing listens on port 9 locally, so the startup sign-in fails fast and is reported, not fatal.
const FULL_ENV = {
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_ANON_KEY: "test-anon-key",
  PRA_EMAIL: "someone@example.com",
  PRA_PASSWORD: "not-a-real-password",
};

function run(env: Record<string, string | undefined>): ChildProcess {
  return spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", MAIN], {
    env: { PATH: process.env.PATH, PRA_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function collect(proc: ChildProcess): { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (err += d));
  return { out: () => out, err: () => err };
}

for (const missing of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "PRA_EMAIL", "PRA_PASSWORD"]) {
  test(`exits non-zero with missing_auth before listening when ${missing} is unset`, async () => {
    const proc = run({ ...FULL_ENV, [missing]: undefined });
    const io = collect(proc);
    const [code] = await once(proc, "exit");
    assert.notEqual(code, 0);
    assert.match(io.err(), /missing_auth/);
    assert.doesNotMatch(io.out(), /listening/);
  });
}

test("serves health, the page, config, and MCP on one port", async (t) => {
  const proc = run(FULL_ENV);
  t.after(() => proc.kill("SIGTERM"));
  const base = await new Promise<string>((resolve, reject) => {
    let out = "";
    proc.stdout!.on("data", (d) => {
      out += d;
      const m = out.match(/listening on (http:\S+?)\/?\s/);
      if (m) resolve(m[1]);
    });
    proc.on("exit", (code) => reject(new Error(`main exited ${code}`)));
  });

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok");

  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  await page.body?.cancel();

  const config = await fetch(`${base}/config.json`);
  assert.deepEqual(await config.json(), { supabaseUrl: FULL_ENV.SUPABASE_URL, anonKey: FULL_ENV.SUPABASE_ANON_KEY });

  const dictate = await fetch(`${base}/dictate`, { method: "POST", body: "x" });
  assert.equal(dictate.status, 401);
  await dictate.body?.cancel();

  const mcp = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(mcp.status, 200);
  const body: any = await mcp.json();
  assert.ok(body.result.tools.some((tool: { name: string }) => tool.name === "get_period"));
});
