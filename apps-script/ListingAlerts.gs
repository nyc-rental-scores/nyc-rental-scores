/**
 * NYC Rental Scores — listing alert reader (Google Apps Script).
 *
 * Reads apartment alert emails (StreetEasy, plus Craigslist, Zillow, RentHop, NYBits and
 * Apartments.com if you set those up too) from this Gmail account and writes one row per
 * listing to the "Listings" tab of the Google Sheet this script is attached to.
 * The website refreshes from that sheet every hour and grades every building.
 *
 * Setup is in apps-script/SETUP.md. You never need to edit this file.
 */

const SHEET_NAME = 'Listings';
const DEBUG_SHEET = 'Unreadable emails';
const LABEL_DONE = 'rental-scores/done';
const HEADERS = ['id', 'source', 'address', 'unit', 'price', 'beds', 'baths', 'neighborhood', 'url', 'received', 'email_subject'];

const SENDERS = {
  streeteasy: 'streeteasy.com',
  craigslist: 'craigslist.org',
  zillow: 'zillow.com',
  renthop: 'renthop.com',
  nybits: 'nybits.com',
  apartments: 'apartments.com',
};

const STREET_WORDS = 'Street|St|Avenue|Ave|Av|Road|Rd|Place|Pl|Boulevard|Blvd|Drive|Dr|Lane|Ln|Parkway|Pkwy|Terrace|Ter|Court|Ct|Square|Sq|Plaza|Way|Broadway|Bowery|Concourse|Highway|Hwy|Expressway|Loop|Walk|Row|Slip|Crescent|Path|Turnpike|Tpke';
const ADDRESS_RE = new RegExp(
  '\\b(\\d{1,5}(?:-\\d{1,4})?[A-Z]?\\s+(?:(?:East|West|North|South|E\\.?|W\\.?|N\\.?|S\\.?)\\s+)?' +
  '(?:[A-Za-z0-9.\'’]+\\s+){0,4}(?:' + STREET_WORDS + ')\\b\\.?)' +
  '(?:\\s*(?:,\\s*)?(?:#|Apt\\.?|Unit|Apartment)\\s*([A-Za-z0-9-]+))?',
  'i'
);
const PRICE_RE = /\$\s?(\d{1,2},?\d{3})(?!\d)/;
const BEDS_RE = /\b(studio|\d(?:\.\d)?\s*(?:bed|bd|br|bedroom)s?)\b/i;
const BATHS_RE = /\b(\d(?:\.\d)?)\s*(?:bath|ba)s?\b/i;

/** Run once by hand: creates the sheet tabs and the 15-minute schedule. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) sh.appendRow(HEADERS);
  let dbg = ss.getSheetByName(DEBUG_SHEET) || ss.insertSheet(DEBUG_SHEET);
  if (dbg.getLastRow() === 0) dbg.appendRow(['received', 'from', 'subject', 'text (first 3000 characters)']);
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('checkEmail').timeBased().everyMinutes(15).create();
  GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);
  checkEmail();
}

/** Runs every 15 minutes. */
function checkEmail() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SHEET_NAME);
  const dbg = ss.getSheetByName(DEBUG_SHEET);
  const done = GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);
  const from = Object.values(SENDERS).map((d) => 'from:' + d).join(' OR ');
  const threads = GmailApp.search('(' + from + ') -label:' + LABEL_DONE.replace('/', '-') + ' newer_than:14d', 0, 50);

  const existing = new Set(sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues().map((r) => String(r[0])));
  const rows = [];

  threads.forEach((thread) => {
    thread.getMessages().forEach((msg) => {
      const sender = msg.getFrom().toLowerCase();
      const source = Object.keys(SENDERS).find((k) => sender.indexOf(SENDERS[k]) !== -1) || 'other';
      const listings = parseEmail(msg.getBody(), msg.getPlainBody(), source);
      if (!listings.length) {
        dbg.appendRow([msg.getDate(), msg.getFrom(), msg.getSubject(), msg.getPlainBody().slice(0, 3000)]);
      }
      listings.forEach((l) => {
        const id = makeId(l);
        if (existing.has(id)) return;
        existing.add(id);
        rows.push([id, source, l.address, l.unit || '', l.price || '', l.beds || '', l.baths || '', l.neighborhood || '', l.url || '', msg.getDate().toISOString(), msg.getSubject()]);
      });
    });
    thread.addLabel(done);
  });

  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
  trimOld(sh, 45);
}

/** Pull listings out of one alert email. Works on the HTML version, falls back to plain text. */
function parseEmail(html, plain, source) {
  const blocks = htmlToBlocks(html);
  let found = scanBlocks(blocks, source);
  if (!found.length) found = scanBlocks(plain.split(/\n{2,}/).map((t) => ({ text: t, links: (t.match(/https?:\/\/[^\s>)\]]+/g) || []) })), source);
  return found;
}

/** Split an email into chunks (one per table cell / paragraph), keeping the links found in each. */
function htmlToBlocks(html) {
  if (!html) return [];
  const cleaned = html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  const parts = cleaned.split(/<\/(?:td|tr|table|p|div|li|h\d)>/i);
  return parts.map((p) => {
    const links = [];
    p.replace(/href="([^"]+)"/gi, (m, u) => { links.push(u.replace(/&amp;/g, '&')); return m; });
    const text = p.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;/g, "'").replace(/&#36;/g, '$').replace(/[ \t]+/g, ' ').trim();
    return { text: text, links: links };
  }).filter((b) => b.text);
}

/** Find address + price pairs among nearby blocks. */
function scanBlocks(blocks, source) {
  const out = [];
  const seen = {};
  for (let i = 0; i < blocks.length; i++) {
    const m = blocks[i].text.match(ADDRESS_RE);
    if (!m) continue;
    // This listing's details sit in this block and the ones after it, up to the next address.
    let end = i + 1;
    while (end < blocks.length && end < i + 7 && !ADDRESS_RE.test(blocks[end].text)) end++;
    const own = blocks.slice(i, end);
    const before = blocks.slice(Math.max(0, i - 2), i);
    const text = own.map((b) => b.text).join('\n');
    const price = (text.match(PRICE_RE) || before.map((b) => b.text).join('\n').match(PRICE_RE) || [])[1];
    if (!price) continue;
    const address = m[1].replace(/\s+/g, ' ').trim();
    const unit = m[2] || '';
    const key = (address + '#' + unit + '$' + price).toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    const links = own.concat(before).reduce((a, b) => a.concat(b.links), []);
    out.push({
      address: address,
      unit: unit,
      price: Number(price.replace(/,/g, '')),
      beds: ((text.match(BEDS_RE) || [])[1] || '').replace(/\s+/g, ' '),
      baths: (text.match(BATHS_RE) || [])[1] || '',
      neighborhood: guessNeighborhood(text),
      url: pickLink(links, source),
    });
  }
  return out;
}

function guessNeighborhood(text) {
  const m = text.match(/(?:in|Rental Unit in|Apartment in|Condo in|Co-op in|Townhouse in)\s+([A-Z][A-Za-z.' -]{2,40}?)(?:\n|,|\s{2}|$)/);
  return m ? m[1].trim() : '';
}

function pickLink(links, source) {
  const bad = /unsubscribe|preferences|settings|privacy|terms|facebook\.com|twitter|instagram|apple\.com|google\.com\/store|play\.google|\/help|mailto:/i;
  const good = links.filter((u) => /^https?:/.test(u) && !bad.test(u));
  const domain = SENDERS[source];
  const listingLike = good.find((u) => /rental|listing|\/apa\/|\/homedetails|\/building\/|\/apartments?\//i.test(u));
  return listingLike || good.find((u) => domain && u.indexOf(domain) !== -1) || good[0] || '';
}

function makeId(l) {
  const raw = [l.address, l.unit, l.price].join('|').toLowerCase().replace(/\s+/g, ' ');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw);
  return bytes.slice(0, 8).map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

/** Remove rows older than `days` so the sheet stays small. */
function trimOld(sh, days) {
  const n = sh.getLastRow();
  if (n < 2) return;
  const cutoff = Date.now() - days * 86400000;
  const vals = sh.getRange(2, 10, n - 1, 1).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (new Date(vals[i][0]).getTime() < cutoff) sh.deleteRow(i + 2);
  }
}
