import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export type Local = { url: string; anonKey: string };
export type Session = { accessToken: string; refreshToken: string; userId: string; email: string; password: string };
export type RpcResult = { status: number; body: any };

let cached: Local | undefined;

// The tests create users, so they only ever talk to a stack on this machine.
function assertLocal(url: string): string {
  const host = new URL(url).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
    throw new Error(`refusing to run tests against non-local Supabase at ${url}`);
  }
  return url.replace(/\/$/, "");
}

// Read from this project's own `supabase status`, never from SUPABASE_URL, so the tests cannot land
// in another local Supabase project that happens to be exported in the shell.
export function local(): Local {
  if (cached) return cached;
  let out: string;
  try {
    out = execFileSync("npx", ["--no-install", "supabase", "status", "-o", "env"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("local Supabase is not running; run `npx supabase start`");
  }
  const env = Object.fromEntries(
    out
      .split("\n")
      .map((line) => line.match(/^([A-Z_]+)="?(.*?)"?$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => [m[1], m[2]]),
  );
  const url = env.API_URL;
  const anonKey = env.ANON_KEY;
  if (!url || !anonKey) throw new Error("local Supabase is not running; run `npx supabase start`");
  cached = { url: assertLocal(url), anonKey };
  return cached;
}

export async function signUp(): Promise<Session> {
  const { url, anonKey } = local();
  const email = `pra-${randomUUID()}@example.com`;
  const password = `pw-${randomUUID()}`;
  const res = await fetch(`${url}/auth/v1/signup`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body: any = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error(`sign-up failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return { accessToken: body.access_token, refreshToken: body.refresh_token, userId: body.user.id, email, password };
}

export async function rpc(session: Session | null, name: string, args: Record<string, unknown> = {}): Promise<RpcResult> {
  const { url, anonKey } = local();
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${session ? session.accessToken : anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Calls an RPC that is expected to succeed and returns its JSON.
export async function call(session: Session, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const { status, body } = await rpc(session, name, args);
  if (status !== 200) throw new Error(`${name} failed (${status}): ${JSON.stringify(body)}`);
  return body;
}

export async function tableRead(session: Session, table: string): Promise<number> {
  const { url, anonKey } = local();
  const res = await fetch(`${url}/rest/v1/${table}?select=*`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${session.accessToken}` },
  });
  await res.body?.cancel();
  return res.status;
}
