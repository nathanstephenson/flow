// The browser client. It imports the same reducer the TUI uses — /reduce.js is src/client/reduce.ts
// with its types stripped — so the two front-ends cannot disagree about what a transcript means.
import { initialState, reduce } from "/reduce.js";
import { editDiff } from "/diff.js";
import { relativeTime } from "/relative-time.js";

const railEl = document.getElementById("sessions");
const gridEl = document.getElementById("grid");

/** sessionId -> { el, view, source, search, entryEls } */
const panes = new Map();
let sessions = [];
// The rail is rebuilt from scratch on every poll, so the disclosure state cannot live in the DOM.
let settledOpen = false;

async function command(body) {
  const response = await fetch("/api/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
  return (await response.json()).result;
}

async function refreshSessions() {
  sessions = await (await fetch("/api/sessions")).json();
  renderRail();
}

function renderRail() {
  const now = Date.now();
  const active = sessions.filter((session) => session.status !== "settled");
  const settled = sessions.filter((session) => session.status === "settled");

  const children = active.map((session) => sessionRow(session, now));
  // Settled Agent Sessions are the ones their owner is done with, so they are folded away rather
  // than competing for attention with live work.
  if (settled.length > 0) children.push(settledGroup(settled, now));
  railEl.replaceChildren(...children);
}

function settledGroup(settled, now) {
  const details = document.createElement("details");
  details.className = "settled-group";
  details.open = settledOpen;
  details.ontoggle = () => {
    settledOpen = details.open;
  };
  const summary = document.createElement("summary");
  summary.textContent = `settled · ${settled.length}`;
  details.append(summary, ...settled.map((session) => sessionRow(session, now)));
  return details;
}

function sessionRow(session, now) {
  const el = document.createElement("div");
  el.className = `session${panes.has(session.id) ? " open" : ""}`;
  el.innerHTML =
    `<span class="title"></span><span class="meta status-${session.status}"></span>` +
    `<button class="settle" title="settle">settle</button><span class="updated"></span>`;
  el.querySelector(".title").textContent = session.title || session.id;
  el.querySelector(".meta").textContent = `${session.status} · ${session.backend}`;
  el.querySelector(".updated").textContent = relativeTime(session.updatedAt, now);

  const settle = el.querySelector(".settle");
  settle.hidden = session.status === "settled" || session.status === "ended";
  settle.onclick = async (event) => {
    // The row opens the session; settling from it must not.
    event.stopPropagation();
    await command({ type: "settle", sessionId: session.id });
    await refreshSessions();
  };

  el.onclick = () => (panes.has(session.id) ? closePane(session.id) : openPane(session.id));
  return el;
}

function openPane(sessionId) {
  if (panes.has(sessionId)) return;

  const el = document.createElement("section");
  el.className = "pane";
  el.innerHTML = `
    <div class="pane-head">
      <span class="title"></span>
      <select class="models" title="model"></select>
      <select class="effort" title="effort"></select>
      <span class="state"></span>
      <button class="settle">settle</button>
      <button class="abort">abort</button>
      <button class="close">×</button>
    </div>
    <div class="pane-search"><input placeholder="filter transcript" /></div>
    <div class="transcript"></div>
    <form class="composer">
      <textarea placeholder="message — enter to send, shift+enter for a newline"></textarea>
      <button type="submit">send</button>
    </form>`;

  const pane = { el, view: initialState(), source: undefined, search: "", entryEls: new Map(), sessionId };
  panes.set(sessionId, pane);
  gridEl.append(el);

  el.querySelector(".close").onclick = () => closePane(sessionId);
  el.querySelector(".abort").onclick = () => command({ type: "abort", sessionId });
  el.querySelector(".settle").onclick = async () => {
    await command({ type: "settle", sessionId });
    await refreshSessions();
  };
  el.querySelector(".pane-search input").oninput = (event) => {
    pane.search = event.target.value.toLowerCase();
    pane.entryEls.clear();
    renderPane(pane);
  };
  el.querySelector(".models").onchange = (event) =>
    command({ type: "set_model", sessionId, modelId: event.target.value });
  el.querySelector(".effort").onchange = (event) =>
    command({ type: "set_effort", sessionId, effort: event.target.value });

  const composer = el.querySelector(".composer");
  const textarea = composer.querySelector("textarea");
  composer.onsubmit = (event) => {
    event.preventDefault();
    send(pane, textarea);
  };
  textarea.onkeydown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(pane, textarea);
    }
  };

  // Cookie auth: EventSource cannot set an Authorization header, which is why the host offers the
  // one-time /auth handoff that turns a token into an HttpOnly cookie.
  pane.source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events?since=0`);
  pane.source.onmessage = (event) => {
    pane.view = reduce(pane.view, JSON.parse(event.data));
    renderPane(pane);
  };

  renderRail();
  renderPane(pane);
}

function closePane(sessionId) {
  const pane = panes.get(sessionId);
  if (!pane) return;
  pane.source?.close();
  pane.el.remove();
  panes.delete(sessionId);
  renderRail();
}

async function send(pane, textarea) {
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = "";
  // Typing while the agent works queues rather than interrupts; steering is a deliberate act.
  const when = pane.view.status === "running" ? "after_turn" : "now";
  await command({ type: "send", sessionId: pane.sessionId, text, when });
}

function renderPane(pane) {
  const { view, el } = pane;
  const summary = sessions.find((session) => session.id === pane.sessionId);
  el.querySelector(".title").textContent = summary?.title ?? pane.sessionId;

  const queued = view.queue.length > 0 ? ` · ${view.queue.length} queued` : "";
  const state = el.querySelector(".state");
  state.textContent = `${view.status}${queued}${contextLabel(view)}`;
  state.className = `state status-${view.status}${view.queue.length ? " queued" : ""}`;

  // Nothing to settle once it is Settled, and an Ended session cannot be.
  el.querySelector(".settle").hidden = view.status === "settled" || view.status === "ended";

  renderModels(el.querySelector(".models"), view);
  renderEffort(el.querySelector(".effort"), view);
  renderTranscript(pane);
}

function contextLabel(view) {
  if (!view.contextUsage) return "";
  const { used, window } = view.contextUsage;
  return window > 0 ? ` · ${Math.round((used / window) * 100)}% context` : ` · ${used} tokens`;
}

/** Grouped by provider: Claude offers one group, pi offers dozens. Same control either way. */
function renderModels(select, view) {
  const models = view.capabilities?.models ?? [];
  if (select.dataset.count === String(models.length)) {
    if (view.model) select.value = view.model.id;
    return;
  }
  select.dataset.count = String(models.length);
  select.replaceChildren();

  const byProvider = new Map();
  for (const model of models) {
    const provider = model.provider ?? "other";
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  for (const [provider, group] of [...byProvider].sort(([a], [b]) => a.localeCompare(b))) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = provider;
    for (const model of group) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label ?? model.id;
      optgroup.append(option);
    }
    select.append(optgroup);
  }
  if (view.model) select.value = view.model.id;
}

/** Effort belongs to the model in force; a model without one (Claude's haiku) hides the control. */
function renderEffort(select, view) {
  const current = view.capabilities?.models.find((model) => model.id === view.model?.id);
  const levels = (current ?? view.model)?.effortLevels ?? [];
  select.hidden = levels.length === 0;
  if (select.dataset.levels !== levels.join(",")) {
    select.dataset.levels = levels.join(",");
    select.replaceChildren(
      ...levels.map((level) => {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = level;
        return option;
      }),
    );
  }
  if (view.effort && levels.includes(view.effort)) select.value = view.effort;
}

/**
 * Keyed reconciliation rather than a full rebuild: assistant text arrives as snapshots that grow
 * with every delta, and rebuilding the transcript on each one would fight the user's scrolling.
 */
function renderTranscript(pane) {
  const container = pane.el.querySelector(".transcript");
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 40;

  const visible = pane.view.entries.filter((entry) => matches(entry, pane.search));
  const seen = new Set();

  for (const entry of visible) {
    const key = `${entry.kind}:${entry.id}`;
    seen.add(key);
    let el = pane.entryEls.get(key);
    if (!el) {
      el = document.createElement("div");
      pane.entryEls.set(key, el);
      container.append(el);
    }
    updateEntry(el, entry, pane.search);
  }

  for (const [key, el] of pane.entryEls) {
    if (!seen.has(key)) {
      el.remove();
      pane.entryEls.delete(key);
    }
  }

  if (atBottom) container.scrollTop = container.scrollHeight;
}

function matches(entry, search) {
  if (!search) return true;
  const haystack = entry.kind === "tool" ? `${entry.name} ${stringify(entry.result)}` : entry.text;
  return (haystack ?? "").toLowerCase().includes(search);
}

function updateEntry(el, entry, search) {
  if (entry.kind === "tool") {
    el.className = "entry";
    renderTool(el, entry);
    return;
  }
  el.className = `entry ${entry.kind}`;
  el.replaceChildren(...highlight(entry.text, search));
}

function renderTool(el, entry) {
  let details = el.firstElementChild;
  if (!details) {
    details = document.createElement("details");
    details.className = "tool";
    details.innerHTML = `<summary></summary><div class="body"></div>`;
    el.append(details);
  }
  details.dataset.status = entry.status;
  details.querySelector("summary").textContent = `${entry.name} · ${entry.status}`;

  const body = details.querySelector(".body");
  const diff = diffFor(entry);
  if (diff) {
    body.replaceChildren(diff);
    return;
  }
  const pre = document.createElement("pre");
  pre.textContent = `${stringify(entry.input)}\n\n${stringify(entry.result) ?? ""}`.trim();
  body.replaceChildren(pre);
}

/** File edits are the tool output people actually read, so show them as a diff, not as JSON. */
function diffFor(entry) {
  const diff = editDiff(entry.input);
  if (!diff) return undefined;

  const wrapper = document.createElement("pre");
  wrapper.className = "diff";
  if (diff.path) {
    const path = document.createElement("div");
    path.textContent = diff.path;
    wrapper.append(path);
  }
  for (const line of diff.removed) wrapper.append(line_("del", `- ${line}`));
  for (const line of diff.added) wrapper.append(line_("ins", `+ ${line}`));
  return wrapper;
}

function line_(className, text) {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return el;
}

function highlight(text, search) {
  if (!search) return [document.createTextNode(text ?? "")];
  const nodes = [];
  const haystack = text ?? "";
  let index = 0;
  for (;;) {
    const at = haystack.toLowerCase().indexOf(search, index);
    if (at === -1) break;
    if (at > index) nodes.push(document.createTextNode(haystack.slice(index, at)));
    const mark = document.createElement("mark");
    mark.textContent = haystack.slice(at, at + search.length);
    nodes.push(mark);
    index = at + search.length;
  }
  nodes.push(document.createTextNode(haystack.slice(index)));
  return nodes;
}

function stringify(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

let config = { scope: ".", backends: ["claude"] };

document.getElementById("new-session").onclick = async () => {
  const id = await command({ type: "create", scope: config.scope, backend: config.backends[0] });
  await refreshSessions();
  openPane(id);
};

document.addEventListener("keydown", (event) => {
  if (event.key === "n" && event.target === document.body) {
    document.getElementById("new-session").click();
  }
});

config = await (await fetch("/api/config")).json();
await refreshSessions();
setInterval(() => void refreshSessions(), 2000);
for (const session of sessions.slice(0, 1)) openPane(session.id);
