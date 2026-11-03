import { gradeAddress, CATEGORY_LABELS, DATASETS, WINDOWS } from './scoring/grades.js';

const $ = (id) => document.getElementById(id);
const ORDER = ['A', 'B', 'C', 'D', 'F'];
const CATS = Object.keys(CATEGORY_LABELS);
const SOURCE_NAMES = { streeteasy: 'StreetEasy', craigslist: 'Craigslist', zillow: 'Zillow', renthop: 'RentHop', nybits: 'NYBits', apartments: 'Apartments.com', manual: 'Listing', other: 'Listing' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const color = (g) => `var(--${g || 'none'})`;

let thresholds, listings = [], buildings = {};

function chip(cat, g) {
  return `<span class="chip" title="${esc(CATEGORY_LABELS[cat])}: ${g || 'no data'}"><b style="background:${color(g)}">${g || '–'}</b>${esc(CATEGORY_LABELS[cat])}</span>`;
}

function facts(b) {
  return `<ul class="facts">${CATS.map((k) => `<li><b style="background:${color(b.grades[k])}">${b.grades[k] || '–'}</b><span><strong>${esc(CATEGORY_LABELS[k])}.</strong> ${esc(b.details[k])}</span></li>`).join('')}</ul>
  <p class="note">Tax lot ${esc(b.record.bbl)} · ${b.record.units ? `${b.record.units.toLocaleString()} apartments (${esc(b.record.unitsSource)})` : 'apartment count unknown'}${b.record.yearBuilt ? ` · built ${b.record.yearBuilt}` : ''}${b.record.owner ? ` · owner of record: ${esc(b.record.owner)}` : ''} · checked ${esc(b.record.asOf)}.
  <a href="https://hpdonline.nyc.gov/hpdonline/" target="_blank" rel="noopener">HPD Online</a> · <a href="https://whoownswhat.justfix.org/en/bbl/${esc(b.record.bbl)}" target="_blank" rel="noopener">Who Owns What</a></p>`;
}

function bigGrade(g, label = 'overall') {
  return `<div class="big" style="background:${color(g)}" aria-label="${label} grade ${g || 'none'}">${g || '?'}<small>${label}</small></div>`;
}

function card(l) {
  const b = buildings[l.bbl];
  const g = b?.overall;
  const src = SOURCE_NAMES[l.source] || 'Listing';
  const when = l.received ? new Date(l.received).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  return `<article class="card">
    <div class="top">${bigGrade(g)}
      <div><div class="addr">${esc(l.address)}${l.unit ? ` #${esc(l.unit)}` : ''}</div>
      <div class="meta">${esc(l.neighborhood || boroughOf(l) || '')}${when ? ` · seen ${when}` : ''}</div></div>
    </div>
    <div class="row"><span class="price">${l.price ? '$' + l.price.toLocaleString() : ''}</span><span class="meta">${esc([l.beds, l.baths && l.baths + ' bath'].filter(Boolean).join(' · '))}</span></div>
    ${b ? `<div class="chips">${CATS.map((k) => chip(k, b.grades[k])).join('')}</div>
    <details><summary>Why these grades</summary>${facts(b)}</details>`
      : `<p class="note">${l.bbl ? 'Building grades are on the way (next hourly refresh).' : 'Could not match this address to a city building record.'}</p>`}
    ${l.url ? `<div class="row"><a href="${esc(l.url)}" target="_blank" rel="noopener">View on ${esc(src)} →</a></div>` : ''}
  </article>`;
}

function boroughOf(l) {
  const m = (l.label || '').match(/, (New York|Brooklyn|Queens|Bronx|Staten Island),/);
  return m ? (m[1] === 'New York' ? 'Manhattan' : m[1]) : '';
}

function bedsNum(s) {
  if (!s) return null;
  if (/studio/i.test(s)) return 0;
  const m = String(s).match(/\d+(\.\d)?/);
  return m ? +m[0] : null;
}

const atLeast = (g, min) => !min || (g && ORDER.indexOf(g) <= ORDER.indexOf(min));

function render() {
  const boro = $('f-boro').value, maxP = +$('f-price').value || 0, minBeds = $('f-beds').value, minOverall = $('f-overall').value;
  const mins = Object.fromEntries(CATS.map((k) => [k, $(`f-${k}`).value]));
  let rows = listings.filter((l) => {
    const b = buildings[l.bbl];
    if (boro && boroughOf(l) !== boro) return false;
    if (maxP && (!l.price || l.price > maxP)) return false;
    if (minBeds !== '' && (bedsNum(l.beds) ?? -1) < +minBeds) return false;
    if (!atLeast(b?.overall, minOverall)) return false;
    for (const k of CATS) if (mins[k] && !atLeast(b?.grades[k], mins[k])) return false;
    return true;
  });
  const sort = $('f-sort').value;
  if (sort === 'price') rows.sort((a, b) => (a.price || 1e9) - (b.price || 1e9));
  if (sort === 'grade') rows.sort((a, b) => (buildings[b.bbl]?.score ?? -1) - (buildings[a.bbl]?.score ?? -1));
  $('grid').innerHTML = rows.length
    ? rows.slice(0, 300).map(card).join('')
    : `<div class="empty">${listings.length ? 'No listings match these filters.' : 'No listings yet. They appear here as soon as the first alert emails arrive. Meanwhile, check any building with the box above.'}</div>`;
  $('status').textContent = listings.length ? `${rows.length.toLocaleString()} of ${listings.length.toLocaleString()} listings${rows.length > 300 ? ' (showing first 300)' : ''}` : '';
}

async function loadJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(url);
  return r.json();
}

async function init() {
  $('more').innerHTML = CATS.map((k) => `<label>${esc(CATEGORY_LABELS[k])}<select id="f-${k}"><option value="">Any</option><option value="A">A only</option><option value="B">B or better</option><option value="C">C or better</option><option value="D">D or better</option></select></label>`).join('');
  $('more-btn').onclick = () => $('more').classList.toggle('open');
  $('filters').addEventListener('input', render);

  $('method-table').innerHTML = `<tr><th>Grade</th><th>What's counted</th><th>Source</th></tr>` + [
    ['violations', `Housing-code violations found by city inspectors in the past ${WINDOWS.violations} years, per apartment. Serious ones count more (class C ×3, B ×2, A ×1).`],
    ['bedbugs', `Share of apartments the owner reported as infested in yearly bedbug filings, past ${WINDOWS.bedbugs} years.`],
    ['evictions', `Residential evictions carried out by city marshals in the past ${WINDOWS.evictions} years, per 100 apartments.`],
    ['complaints', `Tenant complaints to HPD (via 311) in the past ${WINDOWS.complaints} years, per apartment.`],
    ['court', `Housing-court cases involving HPD in the past ${WINDOWS.court} years, per apartment (harassment cases ×3).`],
  ].map(([k, t]) => `<tr><td><b>${esc(CATEGORY_LABELS[k])}</b></td><td>${esc(t)}</td><td><a href="https://data.cityofnewyork.us/d/${DATASETS[k].id}" target="_blank" rel="noopener">${esc(DATASETS[k].name)}</a></td></tr>`).join('');

  try {
    thresholds = await loadJSON('scoring/thresholds.json');
    $('calibrated').textContent = `Grade cutoffs last recalculated ${new Date(thresholds.generated).toLocaleDateString('en-US', { dateStyle: 'medium' })}.`;
    if (thresholds.population?.violations) $('pop').textContent = thresholds.population.violations.toLocaleString();
  } catch { $('status').textContent = 'Grade cutoffs are missing.'; return; }

  try {
    const [l, b] = await Promise.all([loadJSON('data/listings.json'), loadJSON('data/buildings.json')]);
    listings = l.listings || []; buildings = b || {};
    render();
    if (l.updated) $('status').textContent += ` · updated ${new Date(l.updated).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}`;
  } catch { listings = []; render(); }

  $('lookup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('lookup-input').value.trim();
    if (!q) return;
    const out = $('lookup-result');
    out.innerHTML = '<p>Checking city records…</p>';
    try {
      const r = await gradeAddress(/new york|manhattan|brooklyn|queens|bronx|staten/i.test(q) ? q : `${q}, New York City`, thresholds);
      if (r.error) { out.innerHTML = `<p>${esc(r.error)}</p>`; return; }
      out.innerHTML = `<article class="card"><div class="top">${bigGrade(r.overall)}<div><div class="addr">${esc(r.geo.label)}</div>
        <div class="meta">${r.score != null ? `Score ${r.score}/100` : ''}</div></div></div>
        <div class="chips">${CATS.map((k) => chip(k, r.grades[k])).join('')}</div>${facts({ ...r })}</article>`;
    } catch (err) {
      out.innerHTML = `<p>Couldn't reach the city's data just now. Please try again in a minute.</p>`;
    }
  });
}

init();
