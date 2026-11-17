/**
 * FeedbackWebhook — receives Gallabox "incoming message" webhooks and writes patient replies
 * to the WhatsApp feedback / surgery follow-up messages into the "Feedback Log" tab.
 *
 * Install: open the Google Sheet → Extensions → Apps Script → paste this file → set WEBHOOK_TOKEN
 * → Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Gallabox webhook URL = <web app /exec URL>?token=<WEBHOOK_TOKEN>
 *
 * The patient's name, doctor and message type (feedback / surgery follow-up) are looked up from the
 * most recent row for that phone number in "WhatsApp Send Log". The raw payload is kept in Notes
 * whenever a field could not be read, so nothing is lost if Gallabox's payload shape differs.
 */

var WEBHOOK_TOKEN = 'CHANGE-ME-to-a-long-random-string';

var LOG_TAB = 'Feedback Log';
var SEND_LOG_TAB = 'WhatsApp Send Log';

// Our WhatsApp numbers (last 10 digits) → doctor, used when the Send Log has no match.
var CHANNEL_DOCTORS = {
  '9158680739': 'Dr. Nirmal Patil',
  '9158681123': 'Chetna Hospital',
  '9168690442': 'Dr. Rachana Patil',
  '9168690448': 'Dr. Rachana Patil'
};

function doGet() {
  return ContentService.createTextOutput('FeedbackWebhook is live');
}

function doPost(e) {
  var params = (e && e.parameter) || {};
  if (params.token !== WEBHOOK_TOKEN) return reply_({ ok: false, error: 'bad token' });

  var raw = (e && e.postData && e.postData.contents) || '';
  var body;
  try { body = JSON.parse(raw); } catch (err) { body = {}; }

  var msg = parse_(body);

  // Ignore our own outgoing messages and status callbacks (sent/delivered/read).
  if (msg.outgoing || (!msg.text && !msg.button)) return reply_({ ok: true, skipped: 'not an incoming reply' });

  // Gallabox retries when it doesn't like the Apps Script 302 redirect: drop repeats of the same message id.
  if (msg.id) {
    var cache = CacheService.getScriptCache();
    if (cache.get('m_' + msg.id)) return reply_({ ok: true, skipped: 'duplicate' });
    cache.put('m_' + msg.id, '1', 21600);
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sent = lookupSend_(ss, msg.from);
    var channel = last10_(msg.channel) || (sent && last10_(sent.sentFrom)) || '';
    var doctor = (sent && sent.doctor) || CHANNEL_DOCTORS[channel] || '';
    var type = (sent && sent.type) || '';

    var missing = !msg.from || !msg.id;
    ss.getSheetByName(LOG_TAB).appendRow([
      Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd/MM/yyyy HH:mm:ss'),
      msg.name || (sent && sent.name) || '',
      msg.from ? "'" + msg.from : '',
      doctor,
      channel ? "'" + channel : '',
      type,
      msg.button || '',
      msg.text || '',
      '', '', '',          // Reply Sent, Review Link Sent, Assigned To
      'New',
      '',                  // Resolved At
      missing ? 'raw: ' + raw.slice(0, 45000) : ''
    ]);
  } finally {
    lock.releaseLock();
  }
  return reply_({ ok: true });
}

/** Reads the fields we need from a Gallabox payload, tolerating several shapes. */
function parse_(b) {
  var w = b.whatsapp || (b.payload && b.payload.whatsapp) || b.message || b;
  var contact = b.contact || (b.payload && b.payload.contact) || {};
  var out = {};

  out.id = b.id || b.messageId || w.id || w.messageId || '';
  out.from = digits_(w.from || contact.phone || b.from || b.sender || '');
  out.name = contact.name || (w.profile && w.profile.name) || b.senderName || '';
  out.channel = digits_(
    b.channelPhone || (b.channel && (b.channel.phone || b.channel.phoneNumber)) || w.to || b.to || ''
  );
  out.outgoing = /out|sent|deliver|read|status/i.test(String(b.event || b.type || '')) &&
                 !/receiv|incoming|inbound/i.test(String(b.event || b.type || ''));

  var t = w.type || '';
  if (w.text) out.text = typeof w.text === 'string' ? w.text : w.text.body;
  if (w.button) out.button = w.button.text || w.button.payload;
  if (w.interactive) {
    var i = w.interactive;
    var r = i.button_reply || i.buttonReply || i.list_reply || i.listReply;
    if (r) out.button = r.title || r.id;
  }
  if (!out.text && !out.button && (t === 'text' || b.text)) out.text = (b.text && b.text.body) || b.text || '';
  return out;
}

/** Most recent WhatsApp Send Log row for this phone (matches on last 10 digits). */
function lookupSend_(ss, phone) {
  var key = last10_(phone);
  if (!key) return null;
  var sh = ss.getSheetByName(SEND_LOG_TAB);
  if (!sh) return null;
  var rows = sh.getDataRange().getValues(); // Date, Phone, Name, Type, Doctor, Sent from, Result, Time
  for (var r = rows.length - 1; r >= 1; r--) {
    if (last10_(rows[r][1]) === key) {
      var type = String(rows[r][3]).toLowerCase().indexOf('surg') >= 0 ? 'Surgery follow-up' : 'Feedback';
      return { name: rows[r][2], type: type, doctor: rows[r][4], sentFrom: rows[r][5] };
    }
  }
  return null;
}

function digits_(v) { return String(v || '').replace(/\D/g, ''); }
function last10_(v) { var d = digits_(v); return d.length >= 10 ? d.slice(-10) : ''; }
function reply_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
