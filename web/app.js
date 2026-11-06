// The page keeps no data of its own. It signs in with Supabase Auth and reads and writes everything
// through PostgREST /rpc as the signed-in user. Sums, phases and validation come back from SQL.

const SESSION_KEY = "pra.session";
const $ = (sel, root = document) => root.querySelector(sel);

const state = { config: null, session: null, types: [], today: null, dirty: { daily: false, weekly: false } };

// ---- Supabase Auth and /rpc --------------------------------------------------------------------

class ApiError extends Error {}

async function authRequest(path, body) {
  const res = await fetch(`${state.config.supabaseUrl}/auth/v1/${path}`, {
    method: "POST",
    headers: { apikey: state.config.anonKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(json.error_description ?? json.msg ?? json.message ?? `auth failed (${res.status})`);
  return json;
}

function keepSession(json, email) {
  if (typeof json.access_token !== "string") return null;
  state.session = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    email: json.user?.email ?? email ?? state.session?.email ?? "",
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
  return state.session;
}

function dropSession() {
  state.session = null;
  state.today = null;
  localStorage.removeItem(SESSION_KEY);
}

let refreshing = null;
async function accessToken(force = false) {
  const s = state.session;
  if (!s) throw new ApiError("signed out");
  if (!force && Date.now() < s.expiresAt - 30_000) return s.accessToken;
  refreshing ??= authRequest("token?grant_type=refresh_token", { refresh_token: s.refreshToken })
    .then((json) => keepSession(json))
    .catch((err) => {
      dropSession();
      showSignedOut();
      throw err;
    })
    .finally(() => (refreshing = null));
  return (await refreshing).accessToken;
}

async function postRpc(name, args, token) {
  return fetch(`${state.config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: state.config.anonKey,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
}

async function rpc(name, args = {}) {
  let res = await postRpc(name, args, await accessToken());
  if (res.status === 401) res = await postRpc(name, args, await accessToken(true));
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(body?.message ?? `${name} failed (${res.status})`);
  return body;
}

// ---- Rendering ---------------------------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k === "dataset") Object.assign(node.dataset, v);
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k.includes("-") || k === "style") node.setAttribute(k, v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

let flashTimer;
function flash(message, kind = "error") {
  const node = $("#flash");
  node.textContent = message;
  node.className = `flash ${kind}`;
  node.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (node.hidden = true), kind === "error" ? 6000 : 2500);
}

const MESSAGES = {
  invalid_value: "Enter a number above zero.",
  unknown_activity: "Pick an activity first.",
  invalid_goal: "A hard goal needs an activity, a target above zero, and a period.",
  invalid_activity_type: "Give the activity a name.",
  invalid_checkin: "Write something for the check-in.",
  retro_judged: "This retro is judged and closed.",
};

function report(err) {
  flash(MESSAGES[err.message] ?? err.message);
}

function fmt(n) {
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function typeById(id) {
  return state.types.find((t) => t.id === id);
}

function renderTypes() {
  for (const select of [$("#log-type"), $("#goal-activity")]) {
    const keep = select.value;
    select.replaceChildren(
      ...(state.types.length
        ? state.types.map((t) => el("option", { value: t.id, textContent: t.unit ? `${t.name} (${t.unit})` : t.name }))
        : [el("option", { value: "", textContent: "Add an activity first" })]),
    );
    if (state.types.some((t) => t.id === keep)) select.value = keep;
  }
}

function logRow(log) {
  return el(
    "li",
    { dataset: { id: log.id } },
    el("span", { class: "name", textContent: log.activityName }),
    el("span", { class: "value", textContent: fmt(log.value) }),
    el("span", { class: "unit muted", textContent: log.unit ?? "" }),
  );
}

function renderToday(logs) {
  $("#today-list").replaceChildren(...logs.map(logRow));
  $("#today-empty").hidden = logs.length > 0;
}

function renderGoals(goals) {
  $("#goals-empty").hidden = goals.length > 0;
  $("#goal-list").replaceChildren(...goals.map((g) => (g.goalType === "hard" ? hardGoal(g) : softGoal(g))));
}

function hardGoal(g) {
  const unit = typeById(g.activityTypeId)?.unit ?? "";
  const pct = Math.min(100, (Number(g.sum) / Number(g.targetValue)) * 100);
  return el(
    "li",
    { class: "goal hard", dataset: { id: g.id } },
    el("div", { class: "goal-head" },
      el("span", { class: "name", textContent: g.name }),
      el("span", { class: "progress-text", textContent: `${fmt(g.sum)} of ${fmt(g.targetValue)}` }),
      el("span", { class: "muted", textContent: `${unit} per ${g.period}`.trim() }),
    ),
    el("div", { class: `bar${pct >= 100 ? " done" : ""}` }, el("span", { style: `width:${pct}%` })),
  );
}

function softGoal(g) {
  const status = el(
    "select",
    { "aria-label": "Status", onchange: (e) => act(() => rpc("set_soft_goal_status", { goalId: g.id, status: e.target.value })) },
    ...["not_started", "in_progress", "achieved", "abandoned"].map((s) =>
      el("option", { value: s, textContent: s.replace("_", " "), selected: s === g.status }),
    ),
  );
  const input = el("input", { name: "body", placeholder: "Check-in", "aria-label": "Check-in" });
  const form = el(
    "form",
    {
      class: "inline-form",
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => {
          await rpc("add_soft_goal_checkin", { goalId: g.id, body: input.value });
          input.value = "";
        });
      },
    },
    input,
    el("button", { type: "submit", textContent: "Add" }),
  );
  return el(
    "li",
    { class: "goal soft", dataset: { id: g.id } },
    el("div", { class: "goal-head" }, el("span", { class: "name", textContent: g.name }), status),
    el("ul", { class: "checkins" }, ...(g.checkins ?? []).map((c) =>
      el("li", {},
        el("time", { class: "muted", textContent: new Date(c.createdAt).toLocaleDateString() }),
        el("span", { textContent: c.body }),
      ),
    )),
    form,
  );
}

function renderRetro(kind, period) {
  const card = $(`#${kind}-card`);
  const r = period.retro;
  const area = $(`#${kind}-body`);
  const judged = r.phase === "judged";
  if (!state.dirty[kind] || judged) {
    area.value = r.body;
    state.dirty[kind] = false;
  }
  area.readOnly = judged;
  $(".period-label", card).textContent = kind === "weekly" ? `${period.start} to ${period.end}` : period.start;
  const phase = $(".phase", card);
  phase.textContent = r.phase;
  phase.className = `phase ${r.phase}`;
  for (const b of card.querySelectorAll(".row button")) b.hidden = judged;
  const judgment = $(".judgment", card);
  judgment.hidden = !(r.judgment || r.nextFocus);
  $(".judgment-text", card).textContent = r.judgment;
  $(".focus-text", card).textContent = r.nextFocus;
}

// ---- Loading -----------------------------------------------------------------------------------

async function load() {
  const [types, day, week] = await Promise.all([
    rpc("list_activity_types"),
    rpc("get_period", { period: "day" }),
    rpc("get_period", { period: "week" }),
  ]);
  state.types = types;
  state.today = day.date;
  const logs = await rpc("list_activity_logs", { fromDate: day.date, toDate: day.date });
  $("#today-date").textContent = day.date;
  renderTypes();
  renderToday(logs);
  renderGoals(day.goals);
  renderRetro("daily", day);
  renderRetro("weekly", week);
}

async function act(fn) {
  try {
    await fn();
    await load();
  } catch (err) {
    report(err);
  }
}

// ---- Screens -----------------------------------------------------------------------------------

function showSignedOut() {
  $("#sign-in-card").hidden = false;
  $("#app").hidden = true;
  $("#who").hidden = true;
  $("#today-list").replaceChildren();
  $("#goal-list").replaceChildren();
}

async function showSignedIn() {
  $("#who-email").textContent = state.session.email;
  try {
    await load();
  } catch (err) {
    if (!state.session) return;
    report(err);
  }
  $("#sign-in-card").hidden = true;
  $("#app").hidden = false;
  $("#who").hidden = false;
}

// ---- Events ------------------------------------------------------------------------------------

function credentials() {
  const form = $("#sign-in-form");
  return { email: form.email.value.trim(), password: form.password.value };
}

$("#sign-in-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { email, password } = credentials();
  try {
    keepSession(await authRequest("token?grant_type=password", { email, password }), email);
    e.target.password.value = "";
    await showSignedIn();
  } catch (err) {
    dropSession();
    showSignedOut();
    flash(err.message === "Invalid login credentials" ? "Wrong email or password." : err.message);
  }
});

$("#sign-up").addEventListener("click", async () => {
  const form = $("#sign-in-form");
  if (!form.reportValidity()) return;
  const { email, password } = credentials();
  try {
    const json = await authRequest("signup", { email, password });
    if (!keepSession(json, email)) return flash("Check your email to confirm the account.", "ok");
    form.password.value = "";
    await showSignedIn();
  } catch (err) {
    flash(err.message);
  }
});

$("#sign-out").addEventListener("click", async () => {
  const token = state.session?.accessToken;
  dropSession();
  showSignedOut();
  if (token) {
    fetch(`${state.config.supabaseUrl}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: state.config.anonKey, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
});

$("#log-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const raw = form.value.value.trim();
  try {
    // A blank field goes to SQL as null; log_activity is the one place that rejects it.
    const log = await rpc("log_activity", {
      activityTypeId: form.activityTypeId.value || null,
      value: raw === "" ? null : Number(raw),
    });
    const type = typeById(log.activityTypeId);
    $("#today-list").prepend(logRow({ ...log, activityName: type?.name ?? "", unit: type?.unit ?? "" }));
    $("#today-empty").hidden = true;
    form.value.value = "";
    load().catch(report);
  } catch (err) {
    report(err);
  }
});

$("#type-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  act(async () => {
    const type = await rpc("create_activity_type", { name: form.name.value, unit: form.unit.value });
    form.reset();
    state.types.push(type);
    renderTypes();
    $("#log-type").value = type.id;
  });
});

$("#goal-type").addEventListener("change", (e) => {
  $(".hard-fields").hidden = e.target.value !== "hard";
});

$("#goal-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const form = e.target;
  const hard = form.goalType.value === "hard";
  const target = form.targetValue.value.trim();
  const args = hard
    ? {
        goalType: "hard",
        name: form.name.value,
        activityTypeId: form.activityTypeId.value || null,
        targetValue: target === "" ? null : Number(target),
        period: form.period.value,
      }
    : { goalType: "soft", name: form.name.value };
  act(async () => {
    await rpc("create_goal", args);
    form.reset();
    $(".hard-fields").hidden = false;
  });
});

for (const kind of ["daily", "weekly"]) {
  const card = $(`#${kind}-card`);
  $(`#${kind}-body`).addEventListener("input", () => (state.dirty[kind] = true));
  $(".save", card).addEventListener("click", () => saveRetro(kind));
}

async function saveRetro(kind) {
  const body = $(`#${kind}-body`).value;
  try {
    await rpc("write_retro", { kind, body });
    state.dirty[kind] = false;
    flash("Saved.", "ok");
    await load();
  } catch (err) {
    report(err);
  }
}

// ---- Dictation ---------------------------------------------------------------------------------

let recorder = null;

$("#dictate").addEventListener("click", async () => {
  const button = $("#dictate");
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return flash("Microphone access was refused.");
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
  recorder.addEventListener("stop", async () => {
    stream.getTracks().forEach((t) => t.stop());
    const type = recorder.mimeType || "audio/webm";
    recorder = null;
    button.textContent = "Transcribing…";
    button.disabled = true;
    try {
      await dictate(new Blob(chunks, { type }));
    } finally {
      button.textContent = "Dictate";
      button.disabled = false;
      button.classList.remove("recording");
    }
  });
  recorder.start();
  button.textContent = "Stop";
  button.classList.add("recording");
});

async function dictate(audio) {
  try {
    const send = async (token) =>
      fetch("/dictate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": audio.type },
        body: audio,
      });
    let res = await send(await accessToken());
    if (res.status === 401) res = await send(await accessToken(true));
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(json.error ?? `dictation failed (${res.status})`);
    if (!json.text) return flash("No speech heard.");
    const area = $("#daily-body");
    area.value = area.value.trim() ? `${area.value.trimEnd()}\n${json.text}` : json.text;
    state.dirty.daily = true;
    await saveRetro("daily");
  } catch (err) {
    report(err);
  }
}

// ---- Boot --------------------------------------------------------------------------------------

async function boot() {
  state.config = await (await fetch("/config.json")).json();
  try {
    state.session = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
  } catch {
    state.session = null;
  }
  if (state.session) await showSignedIn();
  else showSignedOut();
}

boot().catch((err) => flash(err.message));
