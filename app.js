/* Diesel Tracker — offline-first behavior logger that syncs to Google Sheets. */

const TAXONOMY = [
  { category: "Touch sensitivity", behaviors: ["Head", "Fore paws", "Hind paws", "Other body parts"] },
  { category: "Guarding", behaviors: ["Ball / toys", "Indoor floor trash", "Food"] },
  { category: "Leash pulling", behaviors: ["Before play", "After play", "Tasty trash"] },
  { category: "Reactivity", behaviors: ["Other dogs", "Skateboards", "Barking at door", "Barking at guests"] },
  { category: "Jumping", behaviors: ["New humans", "Me", "Familiar non-me"] },
  { category: "\"Aggressive\" play", behaviors: ["Park off leash", "With Kai", "Daycare"] },
];

const SEVERITY_LABELS = { green: "Good", yellow: "Watch", orange: "Issue", red: "Incident" };
const SEVERITY_RANK = { green: 0, yellow: 1, orange: 2, red: 3 };
const REACTIVITY_CATEGORY = "Reactivity";
// A reactivity entry at Issue (orange) or worse spoils a "minimal-reactivity" day.
const REACTIVITY_ISSUE_RANK = SEVERITY_RANK.orange;

const store = {
  get entries() { return JSON.parse(localStorage.getItem("entries") || "[]"); },
  set entries(v) { localStorage.setItem("entries", JSON.stringify(v)); },
  get settings() { return JSON.parse(localStorage.getItem("settings") || "{}"); },
  set settings(v) { localStorage.setItem("settings", JSON.stringify(v)); },
  // Manual per-week overrides of the minimal-reactivity-days number, keyed by week-start ms.
  get weekOverrides() { return JSON.parse(localStorage.getItem("weekOverrides") || "{}"); },
  set weekOverrides(v) { localStorage.setItem("weekOverrides", JSON.stringify(v)); },
};

let currentSelection = null; // { category, behavior }
let currentSeverity = null;
let editingId = null; // id of the entry being edited, or null for a new entry
let autoSyncTimer = null;

const $ = (id) => document.getElementById(id);

/* ---------- UI: behavior list ---------- */
function renderBehaviorList() {
  const container = $("behaviorList");
  container.innerHTML = "";
  for (const group of TAXONOMY) {
    const section = document.createElement("div");
    section.className = "category";
    const h = document.createElement("h2");
    h.textContent = group.category;
    section.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "behavior-grid";
    for (const b of group.behaviors) {
      const btn = document.createElement("button");
      btn.className = "behavior-btn";
      btn.textContent = b;
      btn.addEventListener("click", () => openSheet(group.category, b));
      grid.appendChild(btn);
    }
    section.appendChild(grid);
    container.appendChild(section);
  }
}

/* ---------- UI: entry sheet ---------- */
// Format a date as the value a <input type="datetime-local"> expects (local time).
function toLocalInput(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openSheet(category, behavior) {
  editingId = null;
  currentSelection = { category, behavior };
  currentSeverity = null;
  $("sheetTitle").textContent = behavior;
  $("sheetSubtitle").textContent = category;
  $("noteInput").value = "";
  $("entryWhen").value = toLocalInput(Date.now());
  document.querySelectorAll(".sev").forEach((b) => b.classList.remove("selected"));
  $("saveEntryBtn").disabled = true;
  $("entrySheet").hidden = false;
  $("sheetBackdrop").hidden = false;
}

function openEditSheet(entry) {
  editingId = entry.id;
  currentSelection = { category: entry.category, behavior: entry.behavior };
  currentSeverity = entry.severity;
  $("sheetTitle").textContent = "Edit: " + entry.behavior;
  $("sheetSubtitle").textContent = entry.category;
  $("noteInput").value = entry.note || "";
  $("entryWhen").value = toLocalInput(entry.ts);
  document.querySelectorAll(".sev").forEach((b) =>
    b.classList.toggle("selected", b.dataset.severity === entry.severity));
  $("saveEntryBtn").disabled = false;
  $("entrySheet").hidden = false;
  $("sheetBackdrop").hidden = false;
}

function closeSheet() {
  $("entrySheet").hidden = true;
  $("sheetBackdrop").hidden = true;
  currentSelection = null;
  editingId = null;
}

function saveEntry() {
  if (!currentSelection || !currentSeverity) return;
  const whenVal = $("entryWhen").value;
  const ts = whenVal ? new Date(whenVal).toISOString() : new Date().toISOString();
  const note = $("noteInput").value.trim();
  if (editingId) {
    store.entries = store.entries.map((e) =>
      e.id === editingId ? { ...e, severity: currentSeverity, note, ts, synced: false } : e);
    toast("Entry updated.");
  } else {
    const entry = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      ts,
      category: currentSelection.category,
      behavior: currentSelection.behavior,
      severity: currentSeverity,
      note,
      synced: false,
    };
    store.entries = [entry, ...store.entries];
    toast(`Logged: ${entry.behavior} (${SEVERITY_LABELS[entry.severity]})`);
  }
  closeSheet();
  refreshPendingBadge();
  renderHistory();
  renderInsights();
  syncNow({ silent: true });
}

// Quick day-level marker (no behavior picking) for backfilling recall gaps.
function markDay(severity) {
  const dv = $("dayMarkDate").value;
  if (!dv) { toast("Pick a date first."); return; }
  const [y, m, d] = dv.split("-").map(Number);
  const ts = new Date(y, m - 1, d, 12, 0, 0).toISOString();
  const entry = {
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    ts,
    category: REACTIVITY_CATEGORY,
    behavior: "Day marker",
    severity,
    note: "",
    synced: false,
  };
  store.entries = [entry, ...store.entries];
  toast(severity === "orange" ? "Marked a reactivity-issue day." : "Marked a calm day.");
  refreshPendingBadge();
  renderHistory();
  renderInsights();
  syncNow({ silent: true });
}

/* ---------- UI: history ---------- */
function renderHistory() {
  const list = $("historyList");
  const entries = [...store.entries].sort((a, b) => new Date(b.ts) - new Date(a.ts));
  list.innerHTML = "";
  $("historyEmpty").hidden = entries.length > 0;
  for (const e of entries) {
    const li = document.createElement("li");
    li.className = `history-item ${e.severity}`;
    const when = new Date(e.ts).toLocaleString([], {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const left = document.createElement("div");
    left.innerHTML =
      `<div class="title">${escapeHtml(e.behavior)} · ${SEVERITY_LABELS[e.severity]}</div>` +
      `<div class="meta">${escapeHtml(e.category)} · ${when}` +
      (e.synced ? "" : ` · <span class="unsynced">not synced</span>`) +
      `</div>` +
      (e.note ? `<div class="note">${escapeHtml(e.note)}</div>` : "");
    const actions = document.createElement("div");
    actions.className = "item-actions";
    const edit = document.createElement("button");
    edit.className = "edit-btn";
    edit.textContent = "✎";
    edit.title = "Edit";
    edit.addEventListener("click", () => openEditSheet(e));
    const del = document.createElement("button");
    del.className = "delete-btn";
    del.textContent = "✕";
    del.addEventListener("click", () => {
      if (!confirm("Delete this entry? (Already-synced entries stay in the sheet.)")) return;
      store.entries = store.entries.filter((x) => x.id !== e.id);
      renderHistory();
      renderInsights();
      refreshPendingBadge();
    });
    actions.appendChild(edit);
    actions.appendChild(del);
    li.appendChild(left);
    li.appendChild(actions);
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function exportCsv() {
  const rows = [["timestamp", "category", "behavior", "severity", "note", "synced"]];
  for (const e of store.entries) {
    rows.push([e.ts, e.category, e.behavior, e.severity, e.note, e.synced]);
  }
  const csv = rows
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `diesel-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- UI: trends / insights ---------- */
function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Monday-based start of the week containing `ts`, at local midnight.
function startOfWeek(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return d;
}

function fmtWeekRange(weekStart) {
  const end = new Date(weekStart);
  end.setDate(end.getDate() + 6);
  const opts = { month: "short", day: "numeric" };
  return `${weekStart.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}`;
}

// Days elapsed in a week so far: full 7 for past weeks, Mon→today for the current week.
function weekSpanDays(weekStart) {
  const currentWeekStart = startOfWeek(Date.now());
  if (weekStart.getTime() !== currentWeekStart.getTime()) return 7;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.floor((today - weekStart) / 86400000) + 1;
}

// Per-week rollup. Minimal-reactivity days = span days minus days with a logged
// reactivity Issue/Incident — robust to not logging every uneventful day.
function weekStats(entries, weekStart) {
  const issueDays = new Set();
  const trackedDays = new Set();
  let reactIssues = 0;
  for (const e of entries) {
    const k = dayKey(e.ts);
    trackedDays.add(k);
    if (e.category === REACTIVITY_CATEGORY && SEVERITY_RANK[e.severity] >= REACTIVITY_ISSUE_RANK) {
      issueDays.add(k);
      reactIssues++;
    }
  }
  const span = weekSpanDays(weekStart);
  const minimal = Math.max(0, span - issueDays.size);
  return { span, issueDays: issueDays.size, minimal, reactIssues, tracked: trackedDays.size, total: entries.length };
}

function renderInsights() {
  const entries = store.entries;
  const overrides = store.weekOverrides;
  $("trendsEmpty").hidden = entries.length > 0;

  // Group entries by ISO-ish week (keyed by week-start timestamp).
  const weeks = new Map(); // weekKey(ms) -> { start, entries: [] }
  for (const e of entries) {
    const start = startOfWeek(e.ts);
    const key = start.getTime();
    if (!weeks.has(key)) weeks.set(key, { start, entries: [] });
    weeks.get(key).entries.push(e);
  }
  const sortedWeeks = [...weeks.values()].sort((a, b) => b.start - a.start);
  const minimalFor = (w) => {
    const key = String(w.start.getTime());
    const s = weekStats(w.entries, w.start);
    return key in overrides ? overrides[key] : s.minimal;
  };

  // --- Reactivity estimate card ---
  const thisWeekStart = startOfWeek(Date.now());
  const thisWeekKey = String(thisWeekStart.getTime());
  const thisWeek = weeks.get(thisWeekStart.getTime());
  const tw = thisWeek
    ? weekStats(thisWeek.entries, thisWeekStart)
    : weekStats([], thisWeekStart);
  const twMinimal = thisWeekKey in overrides ? overrides[thisWeekKey] : tw.minimal;
  $("reactivityThisWeek").textContent = String(twMinimal);

  const avgEl = $("reactivityAvg");
  const completeWeeks = sortedWeeks.filter((w) => w.start.getTime() !== thisWeekStart.getTime());
  const subNote = `${tw.issueDays} issue day${tw.issueDays === 1 ? "" : "s"} of ${tw.span} so far this week`;
  if (completeWeeks.length === 0) {
    avgEl.innerHTML = `First week in progress — a weekly average appears once a full week is logged.` +
      `<br><span class="hint">${subNote}</span>`;
  } else {
    const avg = completeWeeks.reduce((s, w) => s + minimalFor(w), 0) / completeWeeks.length;
    avgEl.innerHTML =
      `<strong>≈ ${avg.toFixed(1)} days/week</strong> across ` +
      `${completeWeeks.length} complete week${completeWeeks.length === 1 ? "" : "s"}` +
      `<br><span class="hint">${subNote}</span>`;
  }

  // --- This week, by behavior (mirrors the sheet's weekly summary) ---
  const weekSummary = $("weekSummary");
  weekSummary.innerHTML = "";
  $("weekRange").textContent = fmtWeekRange(thisWeekStart);
  if (!thisWeek) {
    weekSummary.innerHTML = `<p class="hint">Nothing logged this week yet.</p>`;
  } else {
    // worst severity + count per behavior, grouped by the canonical taxonomy order.
    const byBehavior = new Map(); // "cat beh" -> { count, worst }
    for (const e of thisWeek.entries) {
      const k = e.category + " " + e.behavior;
      const cur = byBehavior.get(k) || { count: 0, worst: "green" };
      cur.count++;
      if (SEVERITY_RANK[e.severity] > SEVERITY_RANK[cur.worst]) cur.worst = e.severity;
      byBehavior.set(k, cur);
    }
    for (const group of TAXONOMY) {
      const rows = group.behaviors
        .map((b) => ({ behavior: b, stat: byBehavior.get(group.category + " " + b) }))
        .filter((r) => r.stat);
      if (rows.length === 0) continue;
      const cat = document.createElement("div");
      cat.className = "sum-cat";
      cat.textContent = group.category;
      weekSummary.appendChild(cat);
      for (const r of rows) {
        const row = document.createElement("div");
        row.className = "sum-row";
        row.innerHTML =
          `<span class="sum-name">${escapeHtml(r.behavior)}</span>` +
          `<span class="sum-meta">` +
          `<span class="sum-count">${r.stat.count}×</span>` +
          `<span class="chip ${r.stat.worst}">${SEVERITY_LABELS[r.stat.worst]}</span>` +
          `</span>`;
        weekSummary.appendChild(row);
      }
    }
  }

  // --- Recent weeks breakdown ---
  const hist = $("weeklyHistory");
  hist.innerHTML = "";
  if (sortedWeeks.length === 0) {
    hist.innerHTML = `<p class="hint">No weeks to summarize yet.</p>`;
  } else {
    for (const w of sortedWeeks.slice(0, 8)) {
      const key = String(w.start.getTime());
      const s = weekStats(w.entries, w.start);
      const overridden = key in overrides;
      const shownMin = overridden ? overrides[key] : s.minimal;
      const row = document.createElement("div");
      row.className = "week-row";

      const stats = document.createElement("span");
      stats.className = "week-stats";
      stats.innerHTML =
        `<span class="week-min">${shownMin}/${s.span}</span> min-reactivity days` +
        (overridden ? ` <span class="ovr">(edited)</span>` : "") +
        `<br>${s.total} log${s.total === 1 ? "" : "s"} · ${s.issueDays} issue day${s.issueDays === 1 ? "" : "s"}`;

      const edit = document.createElement("button");
      edit.className = "wk-edit";
      edit.textContent = "✎";
      edit.title = "Override this week's number";
      edit.addEventListener("click", () => {
        const cur = overridden ? overrides[key] : "";
        const input = prompt(
          `Minimal-reactivity days for ${fmtWeekRange(w.start)}\n` +
          `(calculated: ${s.minimal}; leave blank to use the calculated value)`,
          String(cur));
        if (input === null) return;
        const ov = store.weekOverrides;
        if (input.trim() === "") {
          delete ov[key];
        } else {
          const n = Number(input);
          if (!Number.isFinite(n) || n < 0) { toast("Enter a number ≥ 0."); return; }
          ov[key] = n;
        }
        store.weekOverrides = ov;
        renderInsights();
      });

      const left = document.createElement("span");
      left.className = "week-range";
      left.textContent = fmtWeekRange(w.start);

      const right = document.createElement("span");
      right.className = "week-right";
      right.appendChild(stats);
      right.appendChild(edit);

      row.appendChild(left);
      row.appendChild(right);
      hist.appendChild(row);
    }
  }
}

/* ---------- Sync ---------- */
function refreshPendingBadge() {
  const pending = store.entries.filter((e) => !e.synced).length;
  const badge = $("pendingBadge");
  badge.hidden = pending === 0;
  badge.textContent = pending;
}

async function syncNow({ silent = false } = {}) {
  const { scriptUrl, scriptToken } = store.settings;
  const pending = store.entries.filter((e) => !e.synced);
  if (!scriptUrl) {
    if (!silent) toast("Set the Apps Script URL in Settings first.");
    return;
  }
  if (pending.length === 0) {
    if (!silent) toast("Nothing to sync — sheet is up to date.");
    return;
  }
  if (!navigator.onLine) {
    if (!silent) toast("Offline — will sync when you're back online.");
    return;
  }

  const btn = $("syncNowBtn");
  btn.classList.add("spinning");
  try {
    const res = await fetch(scriptUrl, {
      method: "POST",
      // text/plain avoids a CORS preflight, which Apps Script can't answer
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        token: scriptToken || "",
        entries: pending.map(({ id, ts, category, behavior, severity, note }) => ({
          id, ts, category, behavior, severity, note,
        })),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Sync rejected");
    const syncedIds = new Set(pending.map((e) => e.id));
    store.entries = store.entries.map((e) =>
      syncedIds.has(e.id) ? { ...e, synced: true } : e);
    store.settings = { ...store.settings, lastSync: new Date().toISOString() };
    if (!silent) toast(`Synced ${pending.length} entr${pending.length === 1 ? "y" : "ies"} to the sheet.`);
    refreshPendingBadge();
    renderHistory();
  } catch (err) {
    if (!silent) toast(`Sync failed: ${err.message}`);
  } finally {
    btn.classList.remove("spinning");
  }
}

async function testConnection() {
  const url = $("scriptUrl").value.trim();
  const msg = $("settingsMsg");
  if (!url) { msg.textContent = "Enter the Apps Script URL first."; return; }
  msg.textContent = "Testing…";
  try {
    const res = await fetch(url);
    const data = await res.json();
    msg.textContent = data.ok ? "✅ Connected to the Apps Script endpoint." : "⚠️ Endpoint responded but not as expected.";
  } catch {
    msg.textContent = "❌ Could not reach the endpoint. Check the URL and that the web app is deployed for 'Anyone'.";
  }
}

function scheduleAutoSync() {
  if (autoSyncTimer) clearInterval(autoSyncTimer);
  const minutes = Number(store.settings.autoSyncMinutes ?? 15);
  if (minutes > 0) {
    autoSyncTimer = setInterval(() => syncNow({ silent: true }), minutes * 60 * 1000);
  }
}

/* ---------- Settings ---------- */
function loadSettingsForm() {
  const s = store.settings;
  $("scriptUrl").value = s.scriptUrl || "";
  $("scriptToken").value = s.scriptToken || "";
  $("autoSyncMinutes").value = String(s.autoSyncMinutes ?? 15);
}

function saveSettings() {
  store.settings = {
    ...store.settings,
    scriptUrl: $("scriptUrl").value.trim(),
    scriptToken: $("scriptToken").value.trim(),
    autoSyncMinutes: Number($("autoSyncMinutes").value),
  };
  scheduleAutoSync();
  $("settingsMsg").textContent = "Saved.";
  toast("Settings saved.");
}

/* ---------- Misc ---------- */
let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function switchScreen(name) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  $(`screen-${name}`).classList.add("active");
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.screen === name));
  if (name === "trends") renderInsights();
}

/* ---------- Init ---------- */
function init() {
  renderBehaviorList();
  renderHistory();
  renderInsights();
  refreshPendingBadge();
  loadSettingsForm();
  scheduleAutoSync();

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchScreen(t.dataset.screen)));

  document.querySelectorAll(".sev").forEach((b) =>
    b.addEventListener("click", () => {
      currentSeverity = b.dataset.severity;
      document.querySelectorAll(".sev").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      $("saveEntryBtn").disabled = false;
    }));

  $("dayMarkDate").value = toLocalInput(Date.now()).slice(0, 10);
  $("markCalmBtn").addEventListener("click", () => markDay("green"));
  $("markIssueBtn").addEventListener("click", () => markDay("orange"));

  $("saveEntryBtn").addEventListener("click", saveEntry);
  $("cancelEntryBtn").addEventListener("click", closeSheet);
  $("sheetBackdrop").addEventListener("click", closeSheet);
  $("syncNowBtn").addEventListener("click", () => syncNow());
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("testSyncBtn").addEventListener("click", testConnection);
  $("exportCsvBtn").addEventListener("click", exportCsv);

  window.addEventListener("online", () => syncNow({ silent: true }));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") syncNow({ silent: true });
  });

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

init();
