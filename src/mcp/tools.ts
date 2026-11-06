// One MCP tool per Postgres function. A handler posts its arguments to PostgREST /rpc/<name> as the
// signed-in user and returns the JSON unchanged. The rules (sums, phases, validation) live in SQL.

export type JsonSchema = Record<string, unknown>;
export type ToolDef = { name: string; description: string; inputSchema: JsonSchema };
export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export type SupabaseConfig = { url: string; anonKey: string; email: string; password: string };

const date = { type: "string", format: "date", description: "YYYY-MM-DD" };
const uuid = { type: "string", format: "uuid" };
const softStatus = { type: "string", enum: ["not_started", "in_progress", "achieved", "abandoned"] };
const retroKind = { type: "string", enum: ["daily", "weekly"] };

function schema(properties: Record<string, unknown>, required: string[] = []): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

export const TOOLS: ToolDef[] = [
  {
    name: "create_category",
    description: "Create a category for activity types.",
    inputSchema: schema({ name: { type: "string" }, kind: { type: "string", enum: ["physical", "topic"] } }, [
      "name",
      "kind",
    ]),
  },
  { name: "list_categories", description: "List the user's categories.", inputSchema: schema({}) },
  {
    name: "create_activity_type",
    description: "Create an activity type that logs are recorded against, such as push-ups in reps.",
    inputSchema: schema({ name: { type: "string" }, unit: { type: "string" }, categoryId: uuid }, ["name"]),
  },
  { name: "list_activity_types", description: "List the user's activity types.", inputSchema: schema({}) },
  {
    name: "log_activity",
    description: "Append one log for an activity type. loggedOn defaults to today in the user's timezone.",
    inputSchema: schema(
      { activityTypeId: uuid, value: { type: "number" }, loggedOn: date, note: { type: "string" } },
      ["activityTypeId", "value"],
    ),
  },
  {
    name: "list_activity_logs",
    description: "List the user's logs, newest first, optionally filtered by date range and activity type.",
    inputSchema: schema({ fromDate: date, toDate: date, activityTypeId: uuid }),
  },
  {
    name: "create_goal",
    description:
      "Create a goal. A hard goal needs activityTypeId, targetValue, and period (day or week). " +
      "A soft goal takes only a name and an optional status.",
    inputSchema: schema(
      {
        goalType: { type: "string", enum: ["hard", "soft"] },
        name: { type: "string" },
        activityTypeId: uuid,
        targetValue: { type: "number" },
        period: { type: "string", enum: ["day", "week"] },
        status: softStatus,
      },
      ["goalType", "name"],
    ),
  },
  {
    name: "set_goal_active",
    description: "Activate or deactivate a goal.",
    inputSchema: schema({ goalId: uuid, active: { type: "boolean" } }, ["goalId", "active"]),
  },
  {
    name: "set_soft_goal_status",
    description: "Set a soft goal's status.",
    inputSchema: schema({ goalId: uuid, status: softStatus }, ["goalId", "status"]),
  },
  {
    name: "add_soft_goal_checkin",
    description: "Add a written check-in to a soft goal.",
    inputSchema: schema({ goalId: uuid, body: { type: "string" } }, ["goalId", "body"]),
  },
  {
    name: "list_goals",
    description: "List active goals, or all goals when includeInactive is true.",
    inputSchema: schema({ includeInactive: { type: "boolean" } }),
  },
  {
    name: "get_period",
    description:
      "Read one day or one Monday-to-Sunday week: per-activity sums, goals with derived progress, " +
      "and the retro with its phase. date defaults to today in the user's timezone.",
    inputSchema: schema({ period: { type: "string", enum: ["day", "week"] }, date }),
  },
  {
    name: "write_retro",
    description: "Write the body of the daily or weekly retro that contains date.",
    inputSchema: schema({ kind: retroKind, body: { type: "string" }, date }, ["kind", "body"]),
  },
  {
    name: "set_retro_judgment",
    description: "Store the judgment and the next focus on a retro whose body is written.",
    inputSchema: schema(
      { kind: retroKind, judgment: { type: "string" }, nextFocus: { type: "string" }, date },
      ["kind", "judgment", "nextFocus"],
    ),
  },
  {
    name: "set_timezone",
    description: "Set the user's IANA timezone, which decides what today and a week mean.",
    inputSchema: schema({ timezone: { type: "string" } }, ["timezone"]),
  },
];

const TOOL_NAMES = new Set(TOOLS.map((t) => t.name));

type Session = { accessToken: string; refreshToken: string; expiresAt: number };

class AuthError extends Error {}

// Holds the user's Supabase Auth session. Signs in with email and password, refreshes before the
// access token expires, and falls back to a fresh sign-in when the refresh token is rejected.
export class UserSession {
  #config: SupabaseConfig;
  #session: Session | undefined;
  #pending: Promise<Session> | undefined;

  constructor(config: SupabaseConfig) {
    this.#config = { ...config, url: config.url.replace(/\/$/, "") };
  }

  get url(): string {
    return this.#config.url;
  }

  get anonKey(): string {
    return this.#config.anonKey;
  }

  async accessToken(forceRefresh = false): Promise<string> {
    const s = this.#session;
    if (s && !forceRefresh && Date.now() < s.expiresAt - 30_000) return s.accessToken;
    this.#pending ??= this.#renew().finally(() => {
      this.#pending = undefined;
    });
    return (await this.#pending).accessToken;
  }

  async #renew(): Promise<Session> {
    const stale = this.#session;
    if (stale) {
      try {
        return (this.#session = await this.#token("refresh_token", { refresh_token: stale.refreshToken }));
      } catch {
        this.#session = undefined;
      }
    }
    return (this.#session = await this.#token("password", {
      email: this.#config.email,
      password: this.#config.password,
    }));
  }

  async #token(grantType: string, body: Record<string, string>): Promise<Session> {
    const res = await fetch(`${this.#config.url}/auth/v1/token?grant_type=${grantType}`, {
      method: "POST",
      headers: { apikey: this.#config.anonKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok || typeof json.access_token !== "string") {
      throw new AuthError(json.error_description ?? json.msg ?? json.message ?? `sign-in failed (${res.status})`);
    }
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: Date.now() + expiresIn * 1000 };
  }
}

function text(value: unknown, isError = false): ToolResult {
  const result: ToolResult = { content: [{ type: "text", text: JSON.stringify(value) }] };
  if (isError) result.isError = true;
  return result;
}

async function postRpc(user: UserSession, name: string, args: unknown, token: string): Promise<Response> {
  return fetch(`${user.url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: user.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
}

export function isTool(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAMES.has(name);
}

export async function callTool(user: UserSession, name: string, args: unknown): Promise<ToolResult> {
  let token: string;
  try {
    token = await user.accessToken();
  } catch (err) {
    return text({ error: "auth_failed", message: (err as Error).message }, true);
  }
  try {
    let res = await postRpc(user, name, args ?? {}, token);
    // An expired or revoked JWT is rejected before the function runs, so one retry is safe.
    if (res.status === 401) {
      await res.body?.cancel();
      res = await postRpc(user, name, args ?? {}, await user.accessToken(true));
    }
    const raw = await res.text();
    const body = raw ? JSON.parse(raw) : null;
    return text(body, !res.ok);
  } catch (err) {
    if (err instanceof AuthError) return text({ error: "auth_failed", message: err.message }, true);
    return text({ error: "rpc_failed", message: (err as Error).message }, true);
  }
}
