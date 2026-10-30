/**
 * Read-only Gmail and Calendar bridge for Friday.
 *
 * Runs in Darren's own Google account as a web app. appsscript.json fixes the
 * OAuth scopes to gmail.readonly and calendar.readonly, so Google refuses any
 * change to mail or calendar even if this code were edited to try. Friday never
 * holds a Google token: it calls this URL with the shared key and gets JSON.
 *
 * Setup: Project Settings > Script Properties > add FRIDAY_KEY (a long random
 * value), then Deploy > New deployment > Web app (execute as me, anyone).
 *
 * GET ?key=<FRIDAY_KEY>&cmd=mail&after=<epoch ms>&limit=<n>
 *     ?key=...&cmd=read&id=<message id>
 *     ?key=...&cmd=events&days=<n>
 */

var MAIL_QUERY = 'in:inbox -category:promotions -category:social -category:forums';

function doGet(e) {
  var p = (e && e.parameter) || {};
  var key = PropertiesService.getScriptProperties().getProperty('FRIDAY_KEY');
  if (!key || key.length < 32 || p.key !== key) return json_({ error: 'forbidden' });
  try {
    if (p.cmd === 'mail') return json_({ messages: mail_(Number(p.after || 0), Math.min(Number(p.limit || 20), 50)) });
    if (p.cmd === 'read') return json_({ message: read_(String(p.id || '')) });
    if (p.cmd === 'events') return json_({ events: events_(Math.min(Number(p.days || 14), 31)) });
    return json_({ error: 'unknown cmd' });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

function json_(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}

function header_(payload, name) {
  var headers = (payload && payload.headers) || [];
  for (var i = 0; i < headers.length; i++) {
    if (String(headers[i].name).toLowerCase() === name.toLowerCase()) return headers[i].value;
  }
  return '';
}

// Oldest-first metadata for inbox mail newer than afterMs.
function mail_(afterMs, limit) {
  var q = MAIL_QUERY + (afterMs ? ' after:' + Math.floor(afterMs / 1000) : '');
  var ids = (Gmail.Users.Messages.list('me', { q: q, maxResults: 100 }).messages || []);
  var out = [];
  ids.forEach(function (ref) {
    var m = Gmail.Users.Messages.get('me', ref.id, { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] });
    var received = Number(m.internalDate || 0);
    if (received <= afterMs) return;
    out.push({ id: m.id, thread_id: m.threadId, received_ms: received, from: header_(m.payload, 'From'),
               subject: header_(m.payload, 'Subject'), date: header_(m.payload, 'Date'),
               snippet: m.snippet || '', labels: m.labelIds || [] });
  });
  out.sort(function (a, b) { return a.received_ms - b.received_ms; });
  return out.slice(0, limit);
}

// Body data comes back as bytes or as web-safe base64; normalize to base64.
function normalize_(part) {
  if (part.body && part.body.data && typeof part.body.data !== 'string') {
    part.body.data = Utilities.base64EncodeWebSafe(part.body.data);
  }
  (part.parts || []).forEach(normalize_);
  return part;
}

function read_(id) {
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error('bad id');
  var m = Gmail.Users.Messages.get('me', id, { format: 'full' });
  return { id: m.id, thread_id: m.threadId, payload: normalize_(m.payload || {}) };
}

function events_(days) {
  var now = new Date();
  var items = Calendar.Events.list('primary', {
    timeMin: now.toISOString(), timeMax: new Date(now.getTime() + days * 86400000).toISOString(),
    singleEvents: true, orderBy: 'startTime', maxResults: 100 }).items || [];
  return items.map(function (ev) {
    return { id: ev.id, status: ev.status, summary: ev.summary || '', location: ev.location || '',
             start: (ev.start && (ev.start.dateTime || ev.start.date)) || '',
             end: (ev.end && (ev.end.dateTime || ev.end.date)) || '',
             description: String(ev.description || '').slice(0, 500), updated: ev.updated || '' };
  });
}
