/**
 * Diesel Tracker — single source of truth (SoT) sync endpoint.
 *
 * The "Observations" tab in this spreadsheet IS the database: one row per
 * granular observation. Every surface (the app, direct sheet edits, this
 * script) reads and writes that tab. Weekly trends are just a query over it.
 *
 * One-time setup (see repo README for the full walkthrough):
 *  1. Open the tracker spreadsheet → Extensions → Apps Script.
 *  2. Paste this file in, replacing the default Code.gs.
 *  3. Set TOKEN below to any secret string (also enter it in the app's Settings).
 *  4. Deploy → New deployment → Web app:
 *       - Execute as: Me
 *       - Who has access: Anyone   (the token gates writes)
 *  5. Copy the web app URL into the app's Settings.
 *
 * Endpoint (POST JSON, Content-Type text/plain to avoid a CORS preflight):
 *   { token, action: "push",   observations: [ {id, ts, category, behavior,
 *                                                 severity, note, source,
 *                                                 updatedAt, deleted} ] }
 *   { token, action: "pull",   since?: ISO }      → { observations: [...] }
 *   { token, action: "import", gridSheet?: name } → seeds historical grid rows
 * doGet(?token=&action=pull) is also supported for convenience / health check.
 */

var TOKEN = "CHANGE-ME";            // must match the token entered in the app
var OBS_SHEET_NAME = "Observations"; // the SoT tab (created if missing)
var GRID_SHEET_NAME = "Psych";       // the legacy weekly grid to import from

// Canonical column order for the Observations tab.
var COLS = ["id", "timestamp", "week", "category", "behavior", "severity", "note", "source", "updatedAt", "deleted"];
var COL = {}; COLS.forEach(function (c, i) { COL[c] = i + 1; }); // 1-based

var SEVERITY_LABEL = { green: "Good", yellow: "Watch", orange: "Issue", red: "Incident" };
var SEVERITY_RANK = { green: 0, yellow: 1, orange: 2, red: 3 };
var SEVERITY_COLOR = { green: "#d9ead3", yellow: "#fff2cc", orange: "#fce5cd", red: "#f4cccc" };

/* ============================ routing ============================ */

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.action === "pull") {
    if (TOKEN && p.token !== TOKEN) return jsonResponse({ ok: false, error: "Invalid token" });
    return handlePull({ since: p.since });
  }
  return jsonResponse({ ok: true, service: "diesel-tracker", sot: OBS_SHEET_NAME, time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (TOKEN && body.token !== TOKEN) return jsonResponse({ ok: false, error: "Invalid token" });
    switch (body.action || "push") {
      case "push":        return handlePush(body);
      case "pull":        return handlePull(body);
      case "import":      return handleImport(body);
      case "weeklyDraft": return handleWeeklyDraft(body);
      case "config":      return handleConfig(body);
      case "classEdit":   return handleClassEdit(body);
      case "pullGrid":    return handlePullGrid(body);
      default:            return jsonResponse({ ok: false, error: "Unknown action: " + body.action });
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

/* ============================ push (upsert) ============================ */

// Upsert observations by id. Last-write-wins: an incoming row only overwrites
// a stored one when its updatedAt is newer-or-equal.
function handlePush(body) {
  var observations = body.observations || [];
  if (observations.length === 0) return jsonResponse({ ok: true, applied: 0, skipped: 0 });

  var sheet = getObsSheet();
  normalizeSheet(sheet);
  var index = buildIdIndex(sheet); // id -> { row, updatedAt }
  var applied = 0, skipped = 0;

  observations.forEach(function (o) {
    if (!o.id) return;
    var existing = index[o.id];
    if (existing) {
      if (new Date(o.updatedAt || 0) >= new Date(existing.updatedAt || 0)) {
        writeRow(sheet, existing.row, o);
        applied++;
      } else {
        skipped++;
      }
    } else {
      var row = sheet.getLastRow() + 1;
      writeRow(sheet, row, o);
      index[o.id] = { row: row, updatedAt: o.updatedAt };
      applied++;
    }
  });
  return jsonResponse({ ok: true, applied: applied, skipped: skipped, now: new Date().toISOString() });
}

/* ============================ pull ============================ */

function handlePull(body) {
  var sheet = getObsSheet();
  normalizeSheet(sheet);
  var since = body.since ? new Date(body.since) : null;
  var rows = readAllObs(sheet).filter(function (r) {
    return !since || new Date(r.updatedAt || 0) > since;
  });
  return jsonResponse({ ok: true, observations: rows, now: new Date().toISOString() });
}

/* ============================ shared config (taxonomy) ============================ */

// Last-write-wins store for the editable behavior-class list, so every device
// shares the same taxonomy. Send the local copy + its updatedAt; get the winner back.
function handleConfig(body) {
  var props = PropertiesService.getScriptProperties();
  var storedJson = props.getProperty("TAXONOMY_JSON") || "";
  var storedTs = props.getProperty("TAXONOMY_UPDATED_AT") || "";
  var inTs = body.taxonomyUpdatedAt || "";
  if (body.taxonomy && (!storedTs || (inTs && inTs > storedTs))) {
    storedJson = JSON.stringify(body.taxonomy);
    storedTs = inTs || new Date().toISOString();
    props.setProperty("TAXONOMY_JSON", storedJson);
    props.setProperty("TAXONOMY_UPDATED_AT", storedTs);
  }
  return jsonResponse({ ok: true, taxonomy: storedJson ? JSON.parse(storedJson) : null, taxonomyUpdatedAt: storedTs });
}

/* ============================ read the Psych grid (live mirror) ============================ */

// Return the Psych grid's weekly assessments so the app can mirror it:
// weeks (assessment date keys) + groups (category → behaviors → per-week cell).
function handlePullGrid(body) {
  var grid = SpreadsheetApp.getActiveSpreadsheet().getSheetByName((body && body.gridSheet) || GRID_SHEET_NAME);
  if (!grid) return jsonResponse({ ok: false, error: "Grid sheet not found" });
  var loc = locateGrid(grid);
  if (!loc) return jsonResponse({ ok: false, error: "Could not locate the grid layout." });

  var bg = grid.getDataRange().getBackgrounds();
  var headerVals = loc.values[loc.headerRow] || [];
  var weeks = [];
  loc.dateCols.forEach(function (c) {
    var d = parseGridDate(headerVals[c]);
    if (d) weeks.push({ col: c, key: d });
  });
  weeks.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : 0); });

  var rowIdxs = Object.keys(loc.rowInfo).map(Number).sort(function (a, b) { return a - b; });
  var groups = [], curCat = null, curGroup = null;
  rowIdxs.forEach(function (r) {
    var info = loc.rowInfo[r];
    if (info.category !== curCat) { curCat = info.category; curGroup = { category: curCat, behaviors: [] }; groups.push(curGroup); }
    var cells = {};
    weeks.forEach(function (w) {
      var sev = hexToSeverity(bg[r][w.col]);
      var note = String(loc.values[r][w.col] || "").trim();
      if (sev || note) cells[w.key] = { severity: sev, note: note };
    });
    curGroup.behaviors.push({ behavior: info.behavior, cells: cells });
  });

  return jsonResponse({ ok: true, weeks: weeks.map(function (w) { return w.key; }), groups: groups });
}

/* ============================ propagate class edits to the grid ============================ */

// One-way app → Psych: rename labels in place, or insert a row for a new behavior.
function handleClassEdit(body) {
  var grid = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(body.gridSheet || GRID_SHEET_NAME);
  if (!grid) return jsonResponse({ ok: false, error: "Grid sheet not found" });
  var loc = locateGrid(grid);
  if (!loc) return jsonResponse({ ok: false, error: "Could not locate the grid layout." });
  if (loc.behaviorCol < 0) return jsonResponse({ ok: false, error: "Could not find the behavior label column." });

  switch (body.op) {
    case "renameBehavior": return classRenameBehavior(grid, loc, body.from, body.to);
    case "renameCategory": return classRenameCategory(grid, loc, body.from, body.to);
    case "addBehavior":    return classAddBehavior(grid, loc, body.category, body.behavior);
    default:               return jsonResponse({ ok: false, error: "Unknown class op: " + body.op });
  }
}

function classRenameBehavior(grid, loc, from, to) {
  var rowIdx = loc.behaviorRows[String(from).toLowerCase()];
  if (rowIdx === undefined) return jsonResponse({ ok: false, error: "Behavior not in grid: " + from });
  grid.getRange(rowIdx + 1, loc.behaviorCol + 1).setValue(to);
  return jsonResponse({ ok: true, op: "renameBehavior", row: rowIdx + 1 });
}

// Rename the category label cell, preserving any trailing qualifier (e.g. "(non-prong)").
function classRenameCategory(grid, loc, from, to) {
  if (loc.categoryCol < 0) return jsonResponse({ ok: false, error: "Could not find the category label column." });
  var values = loc.values, cc = loc.categoryCol, fromL = String(from).toLowerCase();
  for (var r = loc.headerRow + 1; r < values.length; r++) {
    var v = String(values[r][cc] || "").trim();
    if (v && v.toLowerCase().indexOf(fromL) === 0) {
      var newVal = to + v.substring(String(from).length);
      grid.getRange(r + 1, cc + 1).setValue(newVal);
      return jsonResponse({ ok: true, op: "renameCategory", from: v, to: newVal, row: r + 1 });
    }
  }
  return jsonResponse({ ok: false, error: "Category not in grid: " + from });
}

// Insert a behavior row. If the category exists, add to its group (extending the
// merged category label); otherwise append a new labelled row at the bottom.
function classAddBehavior(grid, loc, category, behavior) {
  var bc = loc.behaviorCol, cc = loc.categoryCol, catL = String(category).toLowerCase();
  var groupRows = [], lastBehaviorRow = loc.headerRow + 1;
  Object.keys(loc.rowInfo).forEach(function (k) {
    var ri = Number(k);
    if (ri > lastBehaviorRow) lastBehaviorRow = ri;
    var pc = String(loc.rowInfo[ri].category || "").toLowerCase();
    if (pc && (pc.indexOf(catL) === 0 || catL.indexOf(pc) === 0)) groupRows.push(ri);
  });

  if (groupRows.length) {
    var maxRow = Math.max.apply(null, groupRows);     // 0-based last row of the group
    grid.insertRowsAfter(maxRow + 1, 1);
    var newRow = maxRow + 2;                            // 1-based new row
    grid.getRange(newRow, bc + 1).setValue(behavior);
    if (cc >= 0) {
      try {
        var catCell = grid.getRange(groupRows[0] + 1, cc + 1);
        var merges = catCell.getMergedRanges();
        if (merges.length) {
          var m = merges[0], rr = m.getRow(), nr = m.getNumRows(), col = m.getColumn(), ncol = m.getNumColumns();
          m.breakApart();
          grid.getRange(rr, col, nr + 1, ncol).merge();
        }
      } catch (e) { /* leave the merge as-is if it can't be extended */ }
    }
    return jsonResponse({ ok: true, op: "addBehavior", row: newRow });
  }

  // New category's first behavior: append a labelled row after the last behavior row.
  grid.insertRowsAfter(lastBehaviorRow + 1, 1);
  var appended = lastBehaviorRow + 2;
  if (cc >= 0) grid.getRange(appended, cc + 1).setValue(category);
  grid.getRange(appended, bc + 1).setValue(behavior);
  return jsonResponse({ ok: true, op: "addBehavior", row: appended, newCategory: true });
}

/* ============================ import historical grid ============================ */

// Reads the legacy weekly grid (values + cell colors) and seeds one coarse
// observation per (week, behavior) into the SoT. Idempotent: existing ids are
// not overwritten, so re-running won't clobber later edits.
function handleImport(body) {
  var gridName = body.gridSheet || GRID_SHEET_NAME;
  var grid = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(gridName);
  if (!grid) return jsonResponse({ ok: false, error: "Grid sheet not found: " + gridName });

  var values = grid.getDataRange().getValues();
  var backgrounds = grid.getDataRange().getBackgrounds();

  // Find the header row with the most date-like cells.
  var headerRow = -1, dateCols = [], bestCount = 0;
  for (var r = 0; r < Math.min(values.length, 8); r++) {
    var cols = [], count = 0;
    for (var c = 0; c < values[r].length; c++) {
      if (parseGridDate(values[r][c])) { cols.push(c); count++; }
    }
    if (count > bestCount) { bestCount = count; headerRow = r; dateCols = cols; }
  }
  if (headerRow < 0 || dateCols.length === 0) {
    return jsonResponse({ ok: false, error: "Could not locate the date header row in " + gridName });
  }
  var firstDateCol = dateCols[0];
  var weekDates = dateCols.map(function (c) { return parseGridDate(values[headerRow][c]); });

  // Behavior label = the non-empty column closest left of the first date column.
  // Category = left of that, carried down across blank cells.
  var observations = [];
  var carriedCategory = "";
  for (var rr = headerRow + 1; rr < values.length; rr++) {
    var behavior = "", behCol = -1;
    for (var bc = firstDateCol - 1; bc >= 0; bc--) {
      if (String(values[rr][bc]).trim()) { behavior = String(values[rr][bc]).trim(); behCol = bc; break; }
    }
    if (!behavior) continue;
    var category = carriedCategory;
    for (var cc = behCol - 1; cc >= 0; cc--) {
      if (String(values[rr][cc]).trim()) { category = String(values[rr][cc]).trim(); break; }
    }
    if (category) carriedCategory = category;

    for (var di = 0; di < dateCols.length; di++) {
      var col = dateCols[di];
      var note = String(values[rr][col] || "").trim();
      var severity = hexToSeverity(backgrounds[rr][col]);
      if (!note && !severity) continue;
      var week = weekDates[di];
      observations.push({
        id: "hist-" + week + "-" + slug(category) + "-" + slug(behavior),
        ts: week + "T12:00:00.000Z",
        category: category,
        behavior: behavior,
        severity: severity || "",
        note: note,
        source: "sheet-history",
        updatedAt: week + "T12:00:00.000Z",
        deleted: "",
      });
    }
  }

  // Seed without clobbering: only insert ids that don't already exist.
  var sheet = getObsSheet();
  var index = buildIdIndex(sheet);
  var inserted = 0;
  observations.forEach(function (o) {
    if (index[o.id]) return;
    var row = sheet.getLastRow() + 1;
    writeRow(sheet, row, o);
    index[o.id] = { row: row, updatedAt: o.updatedAt };
    inserted++;
  });
  return jsonResponse({ ok: true, parsed: observations.length, inserted: inserted, weeks: weekDates });
}

/* ============================ weekly draft (LLM) ============================ */

// Monday-based start (local midnight) of the week containing `d`.
function mondayOf(d) {
  var x = new Date(d);
  x.setHours(0, 0, 0, 0);
  var dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return x;
}

// Pre-fill a NEW (rightmost) column in the grid for one week: an LLM-written
// summary per behavior + a suggested severity color, derived from that week's
// Observations. Never touches existing columns.
function handleWeeklyDraft(body) {
  body = body || {};
  var grid = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(body.gridSheet || GRID_SHEET_NAME);
  if (!grid) return jsonResponse({ ok: false, error: "Grid sheet not found" });
  var loc = locateGrid(grid);
  if (!loc) return jsonResponse({ ok: false, error: "Could not locate the grid layout." });

  var period = resolvePeriod(body, loc);

  // Daily logs only, within the period — exclude imported history and prior drafts.
  var rows = readAllObs(getObsSheet()).filter(function (o) {
    if (o.deleted) return false;
    if (o.source === "sheet-history" || o.source === "weekly") return false;
    var t = new Date(o.ts);
    return t >= period.start && t < period.endExcl && String(o.behavior).trim();
  });
  if (rows.length === 0) {
    return jsonResponse({ ok: false, error: "No daily logs between " + fmtDate(period.start) + " and " + period.label + " — nothing to draft." });
  }

  var byBehavior = {};
  rows.forEach(function (o) {
    var key = String(o.behavior).trim();
    if (!byBehavior[key]) byBehavior[key] = { category: o.category, notes: [] };
    byBehavior[key].notes.push({
      date: Utilities.formatDate(new Date(o.ts), Session.getScriptTimeZone(), "EEE dd/MM"),
      severity: SEVERITY_LABEL[o.severity] || o.severity || "—",
      note: o.note || "",
    });
  });

  // Minimal-reactivity days over the period: span minus days with a reactivity Issue/Incident.
  var issueDays = {};
  rows.forEach(function (o) {
    if (String(o.category).indexOf("Reactivity") === 0 && SEVERITY_RANK[o.severity] >= 2) {
      issueDays[Utilities.formatDate(new Date(o.ts), Session.getScriptTimeZone(), "yyyy-MM-dd")] = true;
    }
  });
  var minimalDays = Math.max(0, period.spanDays - Object.keys(issueDays).length);

  var drafts = generateWeeklyDrafts(byBehavior, period);
  var written = writeDraftColumn(grid, loc, period, drafts, minimalDays);

  return jsonResponse({ ok: true, period: fmtDate(period.start) + " → " + period.label,
    spanDays: period.spanDays, drafted: Object.keys(drafts).length, written: written,
    minimalDays: minimalDays, drafts: drafts });
}

// Resolve the period to summarize: explicit {start,end} > {weekStart} > since-last-column.
function resolvePeriod(body, loc) {
  var start, endIncl;
  if (body.start && body.end) {
    start = parseLocalDate(body.start);
    endIncl = parseLocalDate(body.end);
  } else if (body.weekStart) {
    start = mondayOf(new Date(body.weekStart));
    endIncl = new Date(start); endIncl.setDate(endIncl.getDate() + 6);
  } else {
    endIncl = midnight(new Date());
    var prev = latestGridDateBefore(loc, endIncl);
    start = prev ? new Date(prev.getTime() + 86400000) : new Date(endIncl.getTime() - 6 * 86400000);
  }
  start = midnight(start); endIncl = midnight(endIncl);
  if (start > endIncl) start = new Date(endIncl);
  var endExcl = new Date(endIncl); endExcl.setDate(endExcl.getDate() + 1);
  return { start: start, endIncl: endIncl, endExcl: endExcl,
    spanDays: Math.round((endIncl - start) / 86400000) + 1, label: fmtDate(endIncl) };
}

function midnight(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function fmtDate(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), "dd/MM/yyyy"); }
function parseLocalDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return midnight(new Date(s + "T00:00:00"));
  return midnight(new Date(s));
}

// Latest existing grid date column strictly before `endIncl` (so re-runs ignore today's column).
function latestGridDateBefore(loc, endIncl) {
  var headerVals = loc.values[loc.headerRow] || [];
  var latest = null;
  loc.dateCols.forEach(function (c) {
    var ds = parseGridDate(headerVals[c]);
    if (!ds) return;
    var d = midnight(new Date(ds + "T00:00:00"));
    if (d < endIncl && (!latest || d > latest)) latest = d;
  });
  return latest;
}

// One Claude call for the whole period; returns { behavior: {severity, summary} }.
function generateWeeklyDrafts(byBehavior, period) {
  var lines = [];
  Object.keys(byBehavior).forEach(function (beh) {
    lines.push("## " + beh);
    byBehavior[beh].notes.forEach(function (n) {
      lines.push("- [" + n.severity + "] " + n.date + ": " + (n.note || "(no note)"));
    });
  });

  var prompt =
    "You are helping summarize a dog's weekly behavior-training log. Below are this week's " +
    "in-the-moment observations, grouped by behavior. Each line shows the logged severity " +
    "(Good/Watch/Issue/Incident) and a note.\n\n" +
    "Summarize ONLY the behaviors listed below, using ONLY the notes provided. Do NOT add any " +
    "behavior that is not listed, and do NOT invent observations, testing, or details that are " +
    "not present in the notes. If a behavior has only one short note, keep its summary minimal.\n\n" +
    "For each behavior, write a concise 1-2 sentence summary in the reflective first-person voice " +
    "the owner uses (e.g. \"better this week, no incidents; still iffy on...\"), and assign the " +
    "week's overall severity. Use this mapping strictly:\n" +
    "- green: no real concerns this week; calm / all good.\n" +
    "- yellow: minor, inconsistent, or worth watching; keeping an eye on it.\n" +
    "- orange: a genuine recurring issue or problem behavior (this is 'Issue').\n" +
    "- red: ONLY for an actual incident — a bite, snap-with-contact, fight, or safety event ('Incident'). " +
    "Do NOT use red for an ordinary issue, even a persistent one.\n" +
    "- none: the behavior was not actually tested or observed this week (e.g. 'untested'). Leave it uncolored.\n" +
    "Base severity on the week as a whole, weighting Issue/Incident days heavily.\n\n" +
    "Return ONLY a JSON object mapping each behavior name exactly as given to " +
    "{\"severity\": \"green|yellow|orange|red|none\", \"summary\": \"...\"}. No prose, no code fences.\n\n" +
    "Period: " + fmtDate(period.start) + " to " + period.label + "\n\n" + lines.join("\n");

  var text = callClaude(prompt);
  // Strip accidental code fences before parsing.
  text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
  var parsed = JSON.parse(text);
  var out = {};
  Object.keys(parsed).forEach(function (beh) {
    if (!Object.prototype.hasOwnProperty.call(byBehavior, beh)) return; // drop any behavior we didn't supply
    var v = parsed[beh] || {};
    var sev = String(v.severity || "").toLowerCase();
    if (!SEVERITY_LABEL[sev]) sev = "";
    out[beh] = { severity: sev, summary: String(v.summary || "").trim() };
  });
  return out;
}

function callClaude(prompt) {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("Set ANTHROPIC_API_KEY in Apps Script → Project Settings → Script properties.");
  var model = props.getProperty("ANTHROPIC_MODEL") || "claude-opus-4-8";

  var res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    muteHttpExceptions: true,
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({
      model: model,
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  var code = res.getResponseCode();
  var data = JSON.parse(res.getContentText());
  if (code !== 200) throw new Error("Claude API " + code + ": " + (data.error && data.error.message || res.getContentText()));
  if (data.stop_reason === "refusal") throw new Error("Claude declined to summarize this week.");
  return (data.content || []).filter(function (b) { return b.type === "text"; })
    .map(function (b) { return b.text; }).join("");
}

// Write the period's draft column. Reuses the column whose header matches the
// period's end date (idempotent), else places it flush after the last date
// column. Clears the column's behavior cells first so stale content never lingers.
function writeDraftColumn(grid, loc, period, drafts, minimalDays) {
  var values = loc.values;
  var label = period.label;

  var headerRowVals = values[loc.headerRow] || [];
  var col = -1;
  for (var i = 0; i < headerRowVals.length; i++) {
    var hv = headerRowVals[i];
    var hs = (hv instanceof Date) ? fmtDate(hv) : String(hv).trim();
    if (hs === label) { col = i + 1; break; }
  }
  if (col < 0) {
    var behRowIdxs = Object.keys(loc.behaviorRows).map(function (k) { return loc.behaviorRows[k]; });
    var c = Math.max.apply(null, loc.dateCols) + 1; // 0-based, after last date col
    for (var guard = 0; guard < 16; guard++, c++) {
      var occupied = false;
      for (var j = 0; j < behRowIdxs.length; j++) {
        var v = (values[behRowIdxs[j]] || [])[c];
        if (v !== "" && v !== null && v !== undefined) { occupied = true; break; }
      }
      if (!occupied) break;
    }
    col = c + 1; // 1-based
  }

  PropertiesService.getScriptProperties().setProperties({
    DRAFT_GRID: grid.getName(), DRAFT_COL: String(col), DRAFT_WEEK: period.start.toISOString(),
  }, false);

  var palette = sampleGridPalette(grid, col);

  // Refresh: clear every behavior cell in this column, then write header + value.
  Object.keys(loc.behaviorRows).forEach(function (k) {
    grid.getRange(loc.behaviorRows[k] + 1, col).clearContent().setBackground(null);
  });
  grid.getRange(loc.headerRow + 1, col).setValue(label).setFontWeight("bold");
  if (loc.minimalRow >= 0) {
    var mcell = grid.getRange(loc.minimalRow + 1, col);
    mcell.setNumberFormat("0");   // force an integer cell so the count isn't shown as a date
    mcell.setValue(minimalDays);
    mcell.setNumberFormat("0");
  }

  var written = 0;
  Object.keys(drafts).forEach(function (beh) {
    var rowIdx = loc.behaviorRows[beh.toLowerCase()];
    if (rowIdx === undefined) return;
    var d = drafts[beh];
    var cell = grid.getRange(rowIdx + 1, col);
    cell.setValue(d.summary).setWrap(true);
    cell.setBackground(d.severity && palette[d.severity] ? palette[d.severity] : null);
    written++;
  });
  return written;
}

// Sample the grid's most-common exact fill per severity (skipping skipCol), so a
// drafted column matches the existing palette instead of a hardcoded one.
function sampleGridPalette(grid, skipCol) {
  var bg = grid.getDataRange().getBackgrounds();
  var counts = { green: {}, yellow: {}, orange: {}, red: {} };
  for (var r = 0; r < bg.length; r++) {
    for (var c = 0; c < bg[r].length; c++) {
      if (skipCol && c + 1 === skipCol) continue;
      var sev = hexToSeverity(bg[r][c]);
      if (!sev) continue;
      var hex = bg[r][c];
      counts[sev][hex] = (counts[sev][hex] || 0) + 1;
    }
  }
  var palette = {};
  ["green", "yellow", "orange", "red"].forEach(function (sev) {
    var best = null, bestN = 0;
    for (var hex in counts[sev]) {
      if (counts[sev][hex] > bestN) { bestN = counts[sev][hex]; best = hex; }
    }
    palette[sev] = best || SEVERITY_COLOR[sev];
  });
  return palette;
}

// Locate the date header row, behavior rows (label→index + category), the
// "Minimal reactivity days" row, the date columns, and the raw values.
function locateGrid(grid) {
  var values = grid.getDataRange().getValues();
  var headerRow = -1, dateCols = [], best = 0;
  for (var r = 0; r < Math.min(values.length, 8); r++) {
    var count = 0, cols = [];
    for (var c = 0; c < values[r].length; c++) {
      if (parseGridDate(values[r][c])) { cols.push(c); count++; }
    }
    if (count > best) { best = count; headerRow = r; dateCols = cols; }
  }
  if (headerRow < 0) return null;

  var minimalRow = -1;
  for (var mr = 0; mr < values.length && minimalRow < 0; mr++) {
    for (var mc = 0; mc < values[mr].length; mc++) {
      if (/minimal\s*reactiv/i.test(String(values[mr][mc]))) { minimalRow = mr; break; }
    }
  }

  var firstDateCol = dateCols[0];
  var behaviorRows = {}, rowInfo = {}, carriedCategory = "", behaviorCol = -1, categoryCol = -1;
  for (var rr = headerRow + 1; rr < values.length; rr++) {
    var behavior = "", behCol = -1;
    for (var bc = firstDateCol - 1; bc >= 0; bc--) {
      var label = String(values[rr][bc]).trim();
      if (label) { behavior = label; behCol = bc; break; }
    }
    if (!behavior) continue;
    if (behaviorCol < 0) behaviorCol = behCol;
    var category = carriedCategory;
    for (var cc = behCol - 1; cc >= 0; cc--) {
      var cv = String(values[rr][cc]).trim();
      if (cv) { category = cv; if (categoryCol < 0) categoryCol = cc; break; }
    }
    if (category) carriedCategory = category;
    behaviorRows[behavior.toLowerCase()] = rr;
    rowInfo[rr] = { behavior: behavior, category: category };
  }
  return { headerRow: headerRow, behaviorRows: behaviorRows, rowInfo: rowInfo,
           dateCols: dateCols, minimalRow: minimalRow, values: values,
           behaviorCol: behaviorCol, categoryCol: categoryCol };
}

// Upsert the human/AI weekly assessment for one (week, behavior) into the SoT.
function upsertWeeklyObservation(weekIso, category, behavior, severity, note) {
  var sheet = getObsSheet();
  var weekStart = new Date(weekIso);
  var id = "weekly-" + weekStartKey(weekStart) + "-" + slug(category) + "-" + slug(behavior);
  var index = buildIdIndex(sheet);
  var ts = new Date(weekStart); ts.setUTCHours(12, 0, 0, 0);
  var row = index[id] ? index[id].row : sheet.getLastRow() + 1;
  writeRow(sheet, row, {
    id: id, ts: ts.toISOString(), category: category, behavior: behavior,
    severity: severity || "", note: note, source: "weekly",
    updatedAt: new Date().toISOString(), deleted: "",
  });
}

function dateKey(d) {
  return Utilities.formatDate(d, "UTC", "yyyy-MM-dd");
}

// Weekly time-driven trigger: draft the just-finished week. Attach via
// Apps Script → Triggers → weeklyDraftTrigger → Time-driven → Week timer.
function weeklyDraftTrigger() {
  var lastWeek = mondayOf(new Date());
  lastWeek.setDate(lastWeek.getDate() - 7);
  handleWeeklyDraft({ weekStart: lastWeek.toISOString() });
}

// Draft an arbitrary week — pass the Monday (or any day) of the target week.
// Run from the editor for ad-hoc / past weeks. Logs the JSON result.
function draftWeek(anyDayInWeekIso) {
  var res = handleWeeklyDraft({ weekStart: new Date(anyDayInWeekIso).toISOString() });
  Logger.log(res.getContent());
  return res;
}

// Holdout test: draft the week ending Sun 14 Jun 2026 (starts Mon 8 Jun).
function draftTestWeek() {
  return draftWeek("2026-06-08T12:00:00.000Z");
}

/* ============================ sheet helpers ============================ */

// Make hand-typed rows first-class: any row with content but no id/updatedAt
// gets stamped so the app can see and order it. Called before every read/write.
function normalizeSheet(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return;
  var range = sheet.getRange(2, 1, last - 1, COLS.length);
  var vals = range.getValues();
  var now = new Date().toISOString();
  var changed = false;
  for (var i = 0; i < vals.length; i++) {
    var row = vals[i];
    var hasContent = String(row[COL.category - 1]).trim() || String(row[COL.behavior - 1]).trim() || String(row[COL.note - 1]).trim();
    if (!hasContent) continue;
    if (String(row[COL.id - 1]).trim() === "") {
      row[COL.id - 1] = "manual-" + Date.now() + "-" + Math.floor(Math.random() * 1e6) + "-" + i;
      if (String(row[COL.updatedAt - 1]).trim() === "") row[COL.updatedAt - 1] = now;
      changed = true;
    }
    if (String(row[COL.updatedAt - 1]).trim() === "") { row[COL.updatedAt - 1] = now; changed = true; }
    if (String(row[COL.week - 1]).trim() === "" && row[COL.timestamp - 1]) {
      row[COL.week - 1] = weekStartKey(new Date(row[COL.timestamp - 1]));
      changed = true;
    }
    if (String(row[COL.source - 1]).trim() === "") { row[COL.source - 1] = "sheet"; changed = true; }
  }
  if (changed) range.setValues(vals);
}

// Simple trigger dispatcher: stamp Observations edits, and write back edits made
// to the live draft column of the grid. Must not throw.
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    var name = sh.getName();
    if (name === OBS_SHEET_NAME) { onEditObservations(e); return; }
    var props = PropertiesService.getScriptProperties();
    if (name === props.getProperty("DRAFT_GRID") && props.getProperty("DRAFT_COL")) {
      onEditDraftColumn(e, props);
    }
  } catch (err) { /* simple triggers must not throw */ }
}

// Stamp updatedAt (and backfill id/week) on any Observations-tab edit, so edits
// to existing rows also propagate to the app.
function onEditObservations(e) {
  var sh = e.range.getSheet();
  var startRow = e.range.getRow();
  var numRows = e.range.getNumRows();
  var now = new Date().toISOString();
  for (var r = startRow; r < startRow + numRows; r++) {
    if (r < 2) continue;
    sh.getRange(r, COL.updatedAt).setValue(now);
    if (String(sh.getRange(r, COL.id).getValue()).trim() === "") {
      sh.getRange(r, COL.id).setValue("manual-" + Date.now() + "-" + Math.floor(Math.random() * 1e6));
    }
    var ts = sh.getRange(r, COL.timestamp).getValue();
    if (String(sh.getRange(r, COL.week).getValue()).trim() === "" && ts) {
      sh.getRange(r, COL.week).setValue(weekStartKey(new Date(ts)));
    }
  }
}

// When the live draft column is edited, upsert the matching weekly Observation
// (severity from the cell's color, summary from its text). Only this column is
// watched — older hand-authored columns are never written back.
function onEditDraftColumn(e, props) {
  var draftCol = Number(props.getProperty("DRAFT_COL"));
  var weekIso = props.getProperty("DRAFT_WEEK");
  var startCol = e.range.getColumn(), numCols = e.range.getNumColumns();
  if (draftCol < startCol || draftCol > startCol + numCols - 1) return;

  var sh = e.range.getSheet();
  var loc = locateGrid(sh);
  if (!loc || !loc.rowInfo) return;
  var startRow = e.range.getRow(), numRows = e.range.getNumRows();
  for (var r = startRow; r < startRow + numRows; r++) {
    var info = loc.rowInfo[r - 1]; // rowInfo keyed by 0-based row index
    if (!info) continue;
    var cell = sh.getRange(r, draftCol);
    upsertWeeklyObservation(weekIso, info.category, info.behavior,
      hexToSeverity(cell.getBackground()), String(cell.getValue()).trim());
  }
}

function getObsSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(OBS_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(OBS_SHEET_NAME);
    sheet.appendRow(COLS);
    sheet.getRange(1, 1, 1, COLS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.hideColumns(COL.id);
    sheet.hideColumns(COL.updatedAt);
  }
  return sheet;
}

function buildIdIndex(sheet) {
  var index = {};
  var last = sheet.getLastRow();
  if (last < 2) return index;
  var ids = sheet.getRange(2, COL.id, last - 1, 1).getValues();
  var upd = sheet.getRange(2, COL.updatedAt, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i][0];
    if (id !== "" && id !== null) index[id] = { row: i + 2, updatedAt: upd[i][0] };
  }
  return index;
}

function writeRow(sheet, row, o) {
  var ts = o.ts ? new Date(o.ts) : new Date();
  var rowValues = [
    o.id,
    ts,
    o.week || weekStartKey(ts),
    o.category || "",
    o.behavior || "",
    o.severity || "",
    o.note || "",
    o.source || "app",
    o.updatedAt || new Date().toISOString(),
    o.deleted ? "TRUE" : "",
  ];
  sheet.getRange(row, 1, 1, COLS.length).setValues([rowValues]);
  var color = o.deleted ? "#eeeeee" : SEVERITY_COLOR[o.severity];
  sheet.getRange(row, 1, 1, COLS.length).setBackground(color || null);
}

function readAllObs(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  var data = sheet.getRange(2, 1, last - 1, COLS.length).getValues();
  return data.filter(function (r) { return r[COL.id - 1] !== ""; }).map(function (r) {
    return {
      id: r[COL.id - 1],
      ts: toIso(r[COL.timestamp - 1]),
      week: r[COL.week - 1],
      category: r[COL.category - 1],
      behavior: r[COL.behavior - 1],
      severity: r[COL.severity - 1],
      note: r[COL.note - 1],
      source: r[COL.source - 1],
      updatedAt: toIso(r[COL.updatedAt - 1]),
      deleted: String(r[COL.deleted - 1]).toUpperCase() === "TRUE",
    };
  });
}

/* ============================ value helpers ============================ */

function toIso(v) {
  if (v instanceof Date) return v.toISOString();
  if (!v) return "";
  var d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toISOString();
}

// Monday-based week-start (YYYY-MM-DD) for a date.
function weekStartKey(d) {
  var x = new Date(d);
  x.setHours(0, 0, 0, 0);
  var dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  return Utilities.formatDate(x, "UTC", "yyyy-MM-dd");
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Parse a grid header value into a YYYY-MM-DD week key, or "" if not a date.
function parseGridDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, "UTC", "yyyy-MM-dd");
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/); // dd/mm/yyyy
  if (!m) return "";
  var day = +m[1], mon = +m[2], year = +m[3];
  if (year < 100) year += 2000;
  if (mon < 1 || mon > 12 || day < 1 || day > 31) return "";
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return year + "-" + pad(mon) + "-" + pad(day);
}

// Classify a cell background hex into a severity, by hue. Pale/grey/white → "".
function hexToSeverity(hex) {
  if (!hex) return "";
  var m = String(hex).replace("#", "");
  if (m.length === 3) m = m[0] + m[0] + m[1] + m[1] + m[2] + m[2];
  if (m.length !== 6) return "";
  var r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
  var max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 16) return ""; // grey / white / untested
  var h;
  if (max === min) h = 0;
  else if (max === r) h = (60 * ((g - b) / (max - min)) + 360) % 360;
  else if (max === g) h = 60 * ((b - r) / (max - min)) + 120;
  else h = 60 * ((r - g) / (max - min)) + 240;
  if (h >= 80 && h <= 175) return "green";
  if (h >= 42 && h < 80) return "yellow";
  if (h >= 18 && h < 42) return "orange";
  return "red";
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
