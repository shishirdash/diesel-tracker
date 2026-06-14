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
      case "push":   return handlePush(body);
      case "pull":   return handlePull(body);
      case "import": return handleImport(body);
      default:       return jsonResponse({ ok: false, error: "Unknown action: " + body.action });
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

// Simple trigger: stamp updatedAt (and backfill id/week) whenever someone edits
// the Observations tab, so edits to existing rows also propagate to the app.
function onEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== OBS_SHEET_NAME) return;
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
  } catch (err) { /* simple triggers must not throw */ }
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
