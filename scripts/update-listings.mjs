// Hourly refresh: read listings from the Google Sheet (filled by the alert-email script)
// plus data/manual-listings.csv, find each building, grade it, and write site/data/*.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { geocode, buildingRecord, gradeRecord } from '../scoring/grades.js';

const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root);
const KEEP_DAYS = 30;          // listings older than this are dropped
const REGRADE_DAYS = 7;        // building grades are refreshed weekly
const CONCURRENCY = 4;
const opts = { appToken: process.env.SODA_APP_TOKEN };

const readJSON = async (p, fallback) => { try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fallback; } };

function parseCSV(text) {
  const rows = []; let row = [], cell = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] || '').trim()])));
}

async function loadListings() {
  const all = [];
  const url = process.env.LISTINGS_CSV_URL;
  if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not read the listings sheet: HTTP ${res.status}`);
    all.push(...parseCSV(await res.text()));
  } else console.log('LISTINGS_CSV_URL not set — skipping the Google Sheet.');
  try { all.push(...parseCSV(await readFile(path('data/manual-listings.csv'), 'utf8')).map((r) => ({ source: 'manual', ...r }))); } catch {}
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  const seen = new Set();
  return all.filter((l) => {
    if (!l.address) return false;
    const t = Date.parse(l.received || '') || Date.now();
    if (t < cutoff) return false;
    const key = (l.id || `${l.address}|${l.unit}|${l.price}`).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const BOROUGH_HINT = /,\s*(new york|manhattan|brooklyn|queens|bronx|staten island|ny)\b/i;

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

const thresholds = await readJSON('scoring/thresholds.json', null);
if (!thresholds) throw new Error('scoring/thresholds.json is missing — run scripts/calibrate.mjs first.');
const geoCache = await readJSON('site/data/geocache.json', {});
const buildings = await readJSON('site/data/buildings.json', {});
const listings = await loadListings();
console.log(`${listings.length} current listings`);

// 1. Find each address.
const addresses = [...new Set(listings.map((l) => l.address.trim()))];
await pool(addresses.filter((a) => !(a.toLowerCase() in geoCache)), CONCURRENCY, async (a) => {
  const query = BOROUGH_HINT.test(a) ? a : `${a}, New York City`;
  try { geoCache[a.toLowerCase()] = (await geocode(query)) || { notFound: true }; }
  catch (e) { console.warn(`address lookup failed for ${a}: ${e.message}`); }
});

// 2. Grade each building (re-using grades less than a week old).
const now = Date.now();
const bbls = [...new Set(addresses.map((a) => geoCache[a.toLowerCase()]?.bbl).filter(Boolean))];
const stale = bbls.filter((b) => !buildings[b] || now - Date.parse(buildings[b].record.asOf) > REGRADE_DAYS * 86400000);
console.log(`${bbls.length} buildings, ${stale.length} to (re)grade`);
await pool(stale, CONCURRENCY, async (bbl) => {
  try {
    const record = await buildingRecord(bbl, opts);
    buildings[bbl] = { record, ...gradeRecord(record, thresholds) };
  } catch (e) { console.warn(`grading failed for ${bbl}: ${e.message}`); }
});

// 3. Write the website's data files.
const out = listings.map((l) => {
  const geo = geoCache[l.address.trim().toLowerCase()];
  return {
    id: l.id || null, source: l.source || 'other', address: l.address, unit: l.unit || '',
    price: Number(String(l.price).replace(/[$,]/g, '')) || null, beds: l.beds || '', baths: l.baths || '',
    neighborhood: l.neighborhood || '', url: l.url || '', received: l.received || null,
    bbl: geo?.bbl || null, label: geo?.label || null, lat: geo?.lat ?? null, lon: geo?.lon ?? null,
  };
}).sort((a, b) => (Date.parse(b.received) || 0) - (Date.parse(a.received) || 0));

const used = new Set(out.map((l) => l.bbl));
for (const b of Object.keys(buildings)) if (!used.has(b) && now - Date.parse(buildings[b].record.asOf) > 60 * 86400000) delete buildings[b];

await mkdir(path('site/data'), { recursive: true });
await writeFile(path('site/data/listings.json'), JSON.stringify({ updated: new Date().toISOString(), listings: out }));
await writeFile(path('site/data/buildings.json'), JSON.stringify(buildings));
await writeFile(path('site/data/geocache.json'), JSON.stringify(geoCache));
console.log(`Wrote ${out.length} listings, ${Object.keys(buildings).length} graded buildings.`);
