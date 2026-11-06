// MCP streamable HTTP server at /mcp. It answers each POST with a single JSON response and keeps no
// session state, so GET (server-initiated SSE) is not offered. Every tool call runs as the user in
// PRA_EMAIL through Supabase Auth; this process never holds a service-role key.
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { TOOLS, UserSession, callTool, isTool } from "./tools.ts";

const SUPPORTED_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY_BYTES = 1_000_000;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const url = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const email = process.env.PRA_EMAIL;
const password = process.env.PRA_PASSWORD;
if (!url || !anonKey || !email || !password) {
  console.error("missing_auth");
  process.exit(1);
}

const user = new UserSession({ url, anonKey, email, password });
const port = Number(process.env.PRA_MCP_PORT ?? 8787);
const host = process.env.PRA_MCP_HOST ?? "127.0.0.1";

type JsonRpcRequest = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));
}

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

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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
  if (req.method !== "POST") return send(res, 405, undefined, { Allow: "POST" });
  let msg: JsonRpcRequest;
  try {
    msg = JSON.parse(await readBody(req));
  } catch (err) {
    const tooLarge = (err as Error).message === "body_too_large";
    return send(res, tooLarge ? 413 : 400, rpcError(null, -32700, tooLarge ? "body too large" : "parse error"));
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return send(res, 400, rpcError(null, -32600, "invalid request"));
  }
  // Notifications carry no id and get no response body.
  if (msg.id === undefined) return send(res, 202);

  try {
    send(res, 200, { jsonrpc: "2.0", id: msg.id, result: await dispatch(msg) });
  } catch (err) {
    if (!(err instanceof RpcFailure)) throw err;
    send(res, 200, rpcError(msg.id, err.code, err.message));
  }
}

const server = createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (!originAllowed(req)) return send(res, 403, rpcError(null, -32000, "origin not allowed"));
  if (path === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (path !== "/mcp") return send(res, 404, { error: "not_found" });
  handleMcp(req, res).catch((err) => {
    console.error("mcp request failed:", err);
    if (!res.headersSent) send(res, 500, rpcError(null, -32603, "internal error"));
  });
});

server.listen(port, host, () => {
  const addr = server.address();
  const bound = typeof addr === "object" && addr ? addr.port : port;
  console.log(`mcp listening on http://${host}:${bound}/mcp`);
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
