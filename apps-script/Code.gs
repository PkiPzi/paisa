/**
 * Paisa mail forwarder. Install on the Gmail account that receives bank alerts.
 * Every 5 minutes it looks for new mail from the senders below and posts each one to the app.
 * It reads nothing else, and never deletes, labels or marks anything.
 *
 * Script Properties (Project Settings -> Script properties):
 *   APP_URL      https://<your-app>.vercel.app   (https, no trailing slash)
 *   CRON_SECRET  same value as in Vercel
 */
var SENDERS = [
  // banks and cards (old and new .bank.in domains)
  'icicibank.com', 'icici.bank.in', 'sbi.co.in', 'sbi.bank.in', 'sbicard.com', 'axisbank.com', 'axis.bank.in',
  // receipts used to label a matching payment
  'rapido.bike', 'uber.com', 'olacabs.com', 'swiggy.in', 'zomato.com', 'blinkit.com', 'zeptonow.com',
  'razorpay.com', // payment receipts sent on a merchant's behalf, e.g. Zepto
];
var MAX_PER_RUN = 40;

/** Banks may send from sub-domains; a receipt must come from exactly the listed domain, so mail from a person there is left alone. */
function wanted(m) {
  var from = m.getFrom();
  var addr = ((from.match(/<([^>]+)>/) || [null, from])[1] || '').toLowerCase();
  var domain = addr.split('@')[1] || '';
  return SENDERS.some(function (d) {
    return domain === d || (/bank|sbi/.test(d) && domain.slice(-d.length - 1) === '.' + d);
  });
}

function forwardMail() {
  var props = PropertiesService.getScriptProperties();
  var url = (props.getProperty('APP_URL') || '').trim().replace(/\/+$/, '');
  var secret = props.getProperty('CRON_SECRET');
  if (!/^https:\/\//.test(url) || !secret) throw new Error('Set APP_URL (https://...) and CRON_SECRET in Script Properties');

  // Cursor = time of the newest message already sent. First run starts 2 days back.
  var cursor = Number(props.getProperty('CURSOR') || 0) || Math.floor(Date.now() / 1000) - 2 * 86400;
  var messages = [];
  GmailApp.search('from:(' + SENDERS.join(' OR ') + ') after:' + (cursor - 60), 0, 50).forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (Math.floor(m.getDate().getTime() / 1000) > cursor && wanted(m)) messages.push(m);
    });
  });
  // the app (and its database) is only woken when there is mail
  if (!messages.length) { console.log('no new mail from the listed senders'); return; }
  messages.sort(function (a, b) { return a.getDate() - b.getDate(); });

  var sent = 0;
  for (var i = 0; i < messages.length && sent < MAX_PER_RUN; i++) {
    var m = messages[i];
    var res = UrlFetchApp.fetch(url + '/api/ingest/email', {
      method: 'post', contentType: 'application/json', muteHttpExceptions: true, followRedirects: false,
      headers: { 'X-Cron-Secret': secret },
      payload: JSON.stringify({
        id: m.getId(), from: m.getFrom(), subject: m.getSubject() || '',
        date: m.getDate().toISOString(), text: (m.getPlainBody() || '').slice(0, 20000),
      }),
    });
    var code = res.getResponseCode();
    // 2xx, or 400 (this one mail is unusable), moves on. Anything else stops so the mail is retried next run;
    // the app ignores a mail it already has.
    if (!(code >= 200 && code < 300) && code !== 400) {
      console.log('stopped at HTTP ' + code + ': ' + res.getContentText().slice(0, 200));
      break;
    }
    cursor = Math.floor(m.getDate().getTime() / 1000);
    sent++;
  }
  props.setProperty('CURSOR', String(cursor));
  console.log('forwarded ' + sent + ' of ' + messages.length);
}

/** Re-sends the last 30 days, e.g. after the parser improves. The app skips mail it already stored. */
function replayLast30Days() {
  PropertiesService.getScriptProperties().setProperty('CURSOR', String(Math.floor(Date.now() / 1000) - 30 * 86400));
  forwardMail();
}

/**
 * Run by hand when nothing arrives. Sends nothing; it only prints what the last 7 days of the inbox hold:
 * mail from the listed senders, and money-looking mail from senders that are NOT in the list.
 */
function checkMail() {
  var show = function (title, query) {
    var threads = GmailApp.search(query, 0, 20);
    console.log(title + ': ' + threads.length);
    threads.forEach(function (t) {
      console.log('  ' + t.getMessages()[0].getFrom() + ' | ' + t.getFirstMessageSubject());
    });
  };
  var listed = 'from:(' + SENDERS.join(' OR ') + ')';
  show('From listed senders', listed + ' newer_than:7d');
  show('Money mail from other senders', '-' + listed + ' newer_than:7d (debited OR credited OR UPI OR "transaction alert" OR "order" OR "payment")');
}

/** Run once by hand. Safe to re-run: it replaces its own trigger. */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'forwardMail') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('forwardMail').timeBased().everyMinutes(5).create();
  console.log('Installed: forwardMail every 5 minutes');
}
