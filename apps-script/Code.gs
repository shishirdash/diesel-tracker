/**
 * Diesel Tracker — Google Sheets sync endpoint.
 *
 * One-time setup (see repo README for the full walkthrough):
 *  1. Open the tracker spreadsheet → Extensions → Apps Script.
 *  2. Paste this file in, replacing the default Code.gs.
 *  3. Set TOKEN below to any secret string (also enter it in the app's Settings).
 *  4. Deploy → New deployment → Web app:
 *       - Execute as: Me
 *       - Who has access: Anyone
 *  5. Copy the web app URL into the app's Settings.
 *  6. (Optional) For the weekly summary tab: Triggers → Add trigger →
 *     buildWeeklySummary → Time-driven → Week timer → pick a day/time.
 */

var TOKEN = "CHANGE-ME"; // must match the token entered in the app
var LOG_SHEET_NAME = "App Log";
var SUMMARY_SHEET_NAME = "Weekly Summary";

var SEVERITY_RANK = { green: 0, yellow: 1, orange: 2, red: 3 };
var SEVERITY_LABEL = { green: "Good", yellow: "Watch", orange: "Issue", red: "Incident" };
var SEVERITY_COLOR = { green: "#d9ead3", yellow: "#fff2cc", orange: "#fce5cd", red: "#f4cccc" };

function doGet() {
  return jsonResponse({ ok: true, service: "diesel-tracker", time: new Date().toISOString() });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    if (TOKEN && body.token !== TOKEN) {
      return jsonResponse({ ok: false, error: "Invalid token" });
    }
    var entries = body.entries || [];
    if (entries.length === 0) {
      return jsonResponse({ ok: true, received: 0 });
    }

    var sheet = getOrCreateLogSheet();
    var existingIds = getExistingIds(sheet);
    var appended = 0;

    entries.forEach(function (entry) {
      if (existingIds[entry.id]) return; // idempotent: skip already-synced entries
      var ts = new Date(entry.ts);
      sheet.appendRow([
        entry.id,
        ts,
        Utilities.formatDate(ts, Session.getScriptTimeZone(), "EEE dd/MM/yyyy"),
        Utilities.formatDate(ts, Session.getScriptTimeZone(), "HH:mm"),
        entry.category,
        entry.behavior,
        SEVERITY_LABEL[entry.severity] || entry.severity,
        entry.note || "",
      ]);
      var color = SEVERITY_COLOR[entry.severity];
      if (color) {
        sheet.getRange(sheet.getLastRow(), 1, 1, 8).setBackground(color);
      }
      appended++;
    });

    return jsonResponse({ ok: true, received: appended });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function getOrCreateLogSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(["ID", "Timestamp", "Date", "Time", "Category", "Behavior", "Severity", "Note"]);
    sheet.getRange(1, 1, 1, 8).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.hideColumns(1); // internal ID, not interesting to viewers
  }
  return sheet;
}

function getExistingIds(sheet) {
  var ids = {};
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().forEach(function (row) {
      ids[row[0]] = true;
    });
  }
  return ids;
}

/**
 * Aggregates the last 7 days of "App Log" into a per-behavior summary —
 * count of entries, worst severity, and the combined notes — so the weekly
 * check-in column in the main tracker is quick to fill in.
 * Attach a weekly time-driven trigger to keep it fresh automatically.
 */
function buildWeeklySummary() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var log = ss.getSheetByName(LOG_SHEET_NAME);
  if (!log || log.getLastRow() < 2) return;

  var cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  var rows = log.getRange(2, 1, log.getLastRow() - 1, 8).getValues();
  var groups = {};

  rows.forEach(function (r) {
    var ts = r[1], category = r[4], behavior = r[5], severityLabel = r[6], note = r[7];
    if (!(ts instanceof Date) || ts < cutoff) return;
    var key = category + " — " + behavior;
    if (!groups[key]) {
      groups[key] = { category: category, behavior: behavior, count: 0, worst: "green", notes: [] };
    }
    var g = groups[key];
    g.count++;
    var sev = labelToSeverity(severityLabel);
    if (SEVERITY_RANK[sev] > SEVERITY_RANK[g.worst]) g.worst = sev;
    if (note) {
      g.notes.push(Utilities.formatDate(ts, Session.getScriptTimeZone(), "dd/MM") + ": " + note);
    }
  });

  var summary = ss.getSheetByName(SUMMARY_SHEET_NAME) || ss.insertSheet(SUMMARY_SHEET_NAME);
  summary.clear();
  summary.appendRow(["Week ending", new Date()]);
  summary.appendRow(["Category", "Behavior", "Entries", "Worst severity", "Notes"]);
  summary.getRange(2, 1, 1, 5).setFontWeight("bold");

  Object.keys(groups).sort().forEach(function (key) {
    var g = groups[key];
    summary.appendRow([g.category, g.behavior, g.count, SEVERITY_LABEL[g.worst], g.notes.join("\n")]);
    summary.getRange(summary.getLastRow(), 4).setBackground(SEVERITY_COLOR[g.worst]);
  });
  summary.autoResizeColumns(1, 4);
}

function labelToSeverity(label) {
  for (var key in SEVERITY_LABEL) {
    if (SEVERITY_LABEL[key] === label) return key;
  }
  return SEVERITY_RANK.hasOwnProperty(label) ? label : "green";
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
