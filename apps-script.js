// QC browser (https://bjhardcastle.github.io/qc-browser/): shared ratings in a Google Sheet.
// Setup (once, ~2 minutes):
//   1. Create a Google Sheet. Extensions -> Apps Script. Replace the code with this file. Save.
//   2. Optionally set TOKEN below to a shared secret (everyone enters it in the app's settings).
//   3. Deploy -> New deployment -> type "Web app"; Execute as: Me; Who has access: Anyone. Deploy, authorise.
//   4. Copy the web app URL (https://script.google.com/macros/s/.../exec) into the app: settings -> Sharing ratings.
// The "ratings" sheet is an append-only log (one row per rating, newest wins per key); the app merges it.
// etag = the image content that was rated, so regenerated figures show up as "changed since rated".
// After editing this script, use Deploy -> Manage deployments -> edit -> Version: New version (the URL stays the same).

const TOKEN = '';           // optional shared secret
const SHEET = 'ratings';
const PAGE = 20000;         // rows per GET

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(['key', 'rating', 'reviewer', 'rated_at_ms', 'note', 'received', 'etag']);
    sh.setFrozenRows(1);
  } else if (sh.getRange(1, 7).getValue() !== 'etag') {
    sh.getRange(1, 7).setValue('etag');   // sheets made by the first version of this script
  }
  return sh;
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// GET ?from=N[&token=...] -> { rows: [[key, rating, reviewer, rated_at_ms, note, received, etag], ...], next: N + rows.length }
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (TOKEN && p.token !== TOKEN) return json_({ error: 'bad token' });
  const sh = sheet_();
  const from = Math.max(0, parseInt(p.from || '0', 10) || 0);
  const total = sh.getLastRow() - 1;
  const n = Math.min(PAGE, total - from);
  if (n <= 0) return json_({ rows: [], next: from });
  const rows = sh.getRange(2 + from, 1, n, 7).getValues();
  return json_({ rows: rows, next: from + n });
}

// POST (text/plain) { token, rows: [[key, rating, reviewer, rated_at_ms, note, etag], ...] } -> { ok, added }
function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ error: 'bad json' }); }
  if (TOKEN && body.token !== TOKEN) return json_({ error: 'bad token' });
  const now = new Date();
  const rows = (body.rows || [])
    .filter(r => Array.isArray(r) && r[0])
    .map(r => [String(r[0]), String(r[1] || ''), String(r[2] || ''), Number(r[3]) || 0, String(r[4] || ''), now, String(r[5] || '')]);
  if (rows.length) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const sh = sheet_();
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
    } finally {
      lock.releaseLock();
    }
  }
  return json_({ ok: true, added: rows.length });
}
