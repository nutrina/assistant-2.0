import { test } from "node:test";
import assert from "node:assert/strict";
import { call, rpc, signUp, tableRead } from "./supabase.ts";
import type { Session } from "./supabase.ts";

async function pushUps(user: Session): Promise<string> {
  const type = await call(user, "create_activity_type", { name: "push-ups", unit: "reps" });
  return type.id;
}

function activitySum(period: any, activityTypeId: string): number | undefined {
  const row = period.activities.find((a: any) => a.activityTypeId === activityTypeId);
  return row === undefined ? undefined : Number(row.sum);
}

test("a day's sum is the total of that day's logs", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);
  await call(user, "log_activity", { activityTypeId: typeId, value: 10, loggedOn: "2026-11-06" });

  const period = await call(user, "get_period", { period: "day", date: "2026-11-06" });

  assert.equal(activitySum(period, typeId), 10);
});

test("each log_activity call appends a row and the period sums them", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);
  await call(user, "log_activity", { activityTypeId: typeId, value: 10, loggedOn: "2026-11-06" });
  await call(user, "log_activity", { activityTypeId: typeId, value: 5, loggedOn: "2026-11-06" });

  const period = await call(user, "get_period", { period: "day", date: "2026-11-06" });
  const logs = await call(user, "list_activity_logs");

  assert.equal(activitySum(period, typeId), 15);
  assert.equal(logs.length, 2);
});

test("a week runs Monday to Sunday", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);
  for (const [loggedOn, value] of [
    ["2026-11-01", 1000], // Sunday of the week before
    ["2026-11-02", 3], // Monday
    ["2026-11-08", 4], // Sunday
    ["2026-11-09", 100], // Monday of the week after
  ] as const) {
    await call(user, "log_activity", { activityTypeId: typeId, value, loggedOn });
  }

  const week = await call(user, "get_period", { period: "week", date: "2026-11-05" });

  assert.equal(week.start, "2026-11-02");
  assert.equal(week.end, "2026-11-08");
  assert.equal(activitySum(week, typeId), 7);
});

test("a hard goal's progress is derived from the logs in its window", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);
  const goal = await call(user, "create_goal", {
    goalType: "hard",
    name: "daily push-ups",
    activityTypeId: typeId,
    targetValue: 20,
    period: "day",
  });
  await call(user, "log_activity", { activityTypeId: typeId, value: 10, loggedOn: "2026-11-06" });
  await call(user, "log_activity", { activityTypeId: typeId, value: 5, loggedOn: "2026-11-06" });
  await call(user, "log_activity", { activityTypeId: typeId, value: 50, loggedOn: "2026-11-05" });

  const period = await call(user, "get_period", { period: "day", date: "2026-11-06" });
  const progress = period.goals.find((g: any) => g.id === goal.id);

  assert.equal(Number(progress.sum), 15);
  assert.equal(Number(progress.targetValue), 20);
});

test("a hard goal without a target is rejected with invalid_goal", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);

  const res = await rpc(user, "create_goal", { goalType: "hard", name: "no target", activityTypeId: typeId, period: "day" });
  const goals = await call(user, "list_goals", { includeInactive: true });

  assert.equal(res.status, 400);
  assert.equal(res.body.message, "invalid_goal");
  assert.ok(!goals.some((g: any) => g.name === "no target"));
});

test("a soft goal carrying hard fields is rejected with invalid_goal", async () => {
  const user = await signUp();

  const res = await rpc(user, "create_goal", { goalType: "soft", name: "read more", targetValue: 3 });

  assert.equal(res.body.message, "invalid_goal");
});

test("a soft goal keeps its status and check-ins", async () => {
  const user = await signUp();
  const goal = await call(user, "create_goal", { goalType: "soft", name: "write more" });
  assert.equal(goal.status, "not_started");

  await call(user, "set_soft_goal_status", { goalId: goal.id, status: "in_progress" });
  await call(user, "add_soft_goal_checkin", { goalId: goal.id, body: "drafted the outline" });
  const [listed] = await call(user, "list_goals");

  assert.equal(listed.status, "in_progress");
  assert.deepEqual(listed.checkins.map((c: any) => c.body), ["drafted the outline"]);
});

test("an inactive goal is listed only when inactive goals are asked for", async () => {
  const user = await signUp();
  const goal = await call(user, "create_goal", { goalType: "soft", name: "paused" });
  await call(user, "set_goal_active", { goalId: goal.id, active: false });

  const active = await call(user, "list_goals");
  const all = await call(user, "list_goals", { includeInactive: true });

  assert.ok(!active.some((g: any) => g.id === goal.id));
  assert.ok(all.some((g: any) => g.id === goal.id));
});

test("a retro moves from open to submitted to judged", async () => {
  const user = await signUp();
  const at = { kind: "daily", date: "2026-11-06" };
  const day = { period: "day", date: "2026-11-06" };

  assert.equal((await call(user, "get_period", day)).retro.phase, "open");
  await call(user, "write_retro", { ...at, body: "shipped the schema" });
  assert.equal((await call(user, "get_period", day)).retro.phase, "submitted");
  await call(user, "set_retro_judgment", { ...at, judgment: "solid day", nextFocus: "write the MCP server" });
  const { retro } = await call(user, "get_period", day);

  assert.equal(retro.phase, "judged");
  assert.equal(retro.judgment, "solid day");
  assert.equal(retro.nextFocus, "write the MCP server");
});

test("judging a retro with a blank body raises retro_open", async () => {
  const user = await signUp();
  const at = { kind: "weekly", date: "2026-11-06" };

  const missing = await rpc(user, "set_retro_judgment", { ...at, judgment: "j", nextFocus: "n" });
  await call(user, "write_retro", { ...at, body: "   " });
  const blank = await rpc(user, "set_retro_judgment", { ...at, judgment: "j", nextFocus: "n" });
  const week = await call(user, "get_period", { period: "week", date: "2026-11-06" });

  assert.equal(missing.body.message, "retro_open");
  assert.equal(blank.body.message, "retro_open");
  assert.equal(week.retro.phase, "open");
});

test("a log on a date is in that date's period after set_timezone", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);
  assert.deepEqual(await call(user, "set_timezone", { timezone: "UTC" }), { timezone: "UTC" });
  await call(user, "log_activity", { activityTypeId: typeId, value: 8, loggedOn: "2026-11-06" });

  const period = await call(user, "get_period", { period: "day", date: "2026-11-06" });

  assert.equal(period.timezone, "UTC");
  assert.equal(activitySum(period, typeId), 8);
  assert.equal((await rpc(user, "set_timezone", { timezone: "Mars/Olympus" })).body.message, "invalid_timezone");
});

test("logging against another user's activity type raises unknown_activity", async () => {
  const owner = await signUp();
  const intruder = await signUp();
  const typeId = await pushUps(owner);

  const res = await rpc(intruder, "log_activity", { activityTypeId: typeId, value: 10, loggedOn: "2026-11-06" });

  assert.equal(res.body.message, "unknown_activity");
  assert.deepEqual(await call(intruder, "list_activity_logs"), []);
  assert.deepEqual(await call(owner, "list_activity_logs"), []);
});

test("a second user does not see the first user's log", async () => {
  const first = await signUp();
  const second = await signUp();
  const typeId = await pushUps(first);
  await call(first, "log_activity", { activityTypeId: typeId, value: 10, loggedOn: "2026-11-06" });

  const theirs = await call(second, "get_period", { period: "day", date: "2026-11-06" });

  assert.deepEqual(theirs.activities, []);
  assert.deepEqual(await call(second, "list_activity_logs"), []);
});

test("tables are not readable directly, only through the functions", async () => {
  const user = await signUp();
  const typeId = await pushUps(user);
  await call(user, "log_activity", { activityTypeId: typeId, value: 10, loggedOn: "2026-11-06" });

  for (const table of ["activity_logs", "activity_types", "goals", "retros", "profiles"]) {
    assert.notEqual(await tableRead(user, table), 200, table);
  }
});

test("an anonymous caller cannot execute the functions", async () => {
  const res = await rpc(null, "get_period", { period: "day", date: "2026-11-06" });

  assert.notEqual(res.status, 200);
});
