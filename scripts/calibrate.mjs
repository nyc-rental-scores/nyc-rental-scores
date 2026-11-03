// Works out where the A–F cutoffs fall, by comparing every NYC rental building.
// A = the best 40% of buildings, B = next 25%, C = next 20%, D = next 10%, F = worst 5%.
// Run monthly by GitHub Actions; writes scoring/thresholds.json.
import { writeFile } from 'node:fs/promises';
import { soda, DATASETS, WINDOWS, sinceDate } from '../scoring/grades.js';

const PCTS = [0.4, 0.65, 0.85, 0.95];
const opts = { appToken: process.env.SODA_APP_TOKEN, timeoutMs: 6 * 60 * 1000 };
const s = Object.fromEntries(Object.entries(WINDOWS).map(([k, y]) => [k, sinceDate(y)]));
const BORO = { MN: '1', BX: '2', BK: '3', QN: '4', SI: '5' };

// One query per borough, run side by side (much faster than one citywide query).
async function all(ds, params, boroWhere) {
  const parts = await Promise.all(['1', '2', '3', '4', '5'].map(async (b) => {
    const where = [params.$where, boroWhere && boroWhere(b)].filter(Boolean).join(' AND ');
    const rows = await soda(DATASETS[ds].id, { ...params, $where: where, $limit: '400000' }, opts);
    console.log(`  ${ds} borough ${b}: ${rows.length} rows`);
    return boroWhere && params.$group?.startsWith('block') ? rows.map((r) => ({ ...r, boroid: b })) : rows;
  }));
  return parts.flat();
}
const byBBL = (b) => `bbl >= '${b}000000000' AND bbl <= '${b}999999999'`;

const bblOf = (b, block, lot) => `${b}${String(block).padStart(5, '0')}${String(lot).padStart(4, '0')}`;

console.log('Rental buildings (PLUTO, 3+ homes)…');
const units = new Map();
for (const r of await all('pluto', { $select: 'borough,block,lot,unitsres', $where: "unitsres::number >= 3" }, (b) => `borough='${Object.keys(BORO).find((k) => BORO[k] === b)}'`)) {
  if (BORO[r.borough]) units.set(bblOf(BORO[r.borough], r.block, r.lot), +r.unitsres);
}
console.log(`  ${units.size} buildings`);

const metric = {};
const add = (name, bbl, v) => { (metric[name] ||= new Map()).set(bbl, (metric[name].get(bbl) || 0) + v); };

console.log('Violations…');
for (const r of await all('violations', {
  $select: "block,lot,sum(case(class='C',3,class='B',2,true,1)) as w",
  $where: `inspectiondate >= '${s.violations}'`, $group: 'block,lot',
}, (b) => `boroid='${b}'`)) add('violations', bblOf(r.boroid, r.block, r.lot), +r.w);

console.log('Complaints…');
for (const r of await all('complaints', {
  $select: 'bbl,count(distinct complaint_id) as n', $where: `received_date >= '${s.complaints}'`, $group: 'bbl',
}, byBBL)) add('complaints', r.bbl, +r.n);

console.log('Evictions…');
for (const r of await all('evictions', {
  $select: 'bbl,count(*) as n', $where: `residential_commercial_ind='Residential' AND executed_date >= '${s.evictions}'`, $group: 'bbl',
}, byBBL)) add('evictions', r.bbl, +r.n);

console.log('Housing court…');
for (const r of await all('court', {
  $select: "bbl,sum(case(casetype='Tenant Action/Harrassment',3,true,1)) as w",
  $where: `caseopendate >= '${s.court}' AND caseopendate <= '${new Date().toISOString().slice(0, 10)}'`, $group: 'bbl',
}, byBBL)) add('court', r.bbl, +r.w);

console.log('Bedbugs…');
const bug = new Map();
for (const r of await all('bedbugs', {
  $select: 'bbl,sum(infested_dwelling_unit_count) as inf,sum(of_dwelling_units) as u', $where: `filing_date >= '${s.bedbugs}'`, $group: 'bbl',
}, byBBL)) if (+r.u > 0) bug.set(r.bbl, +r.inf / +r.u);

const at = (sorted, p) => Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))].toFixed(4));

// Most buildings have zero evictions, court cases, etc. When 40%+ of buildings have none,
// A means "none on record" and buildings with any are split B/C/D/F at their own 50th/75th/90th percentiles.
function cutoffsFor(values) {
  const v = values.slice().sort((a, b) => a - b);
  const zeroShare = v.filter((x) => x === 0).length / v.length;
  if (zeroShare >= 0.4) {
    const nz = v.filter((x) => x > 0);
    return { mode: 'none-or-some', zeroShare: Number(zeroShare.toFixed(3)), cutoffs: [0, at(nz, 0.5), at(nz, 0.75), at(nz, 0.9)] };
  }
  return { mode: 'percentile', zeroShare: Number(zeroShare.toFixed(3)), cutoffs: PCTS.map((p) => at(v, p)) };
}

const cutoffs = {}, population = {}, modes = {};
const series = {};
for (const name of ['violations', 'complaints', 'evictions', 'court']) {
  const m = metric[name] || new Map();
  series[name] = [...units].map(([bbl, u]) => (m.get(bbl) || 0) / u * (name === 'evictions' ? 100 : 1));
}
series.bedbugs = [...bug].filter(([bbl]) => units.has(bbl)).map(([, v]) => v);
for (const [name, vals] of Object.entries(series)) {
  const c = cutoffsFor(vals);
  cutoffs[name] = c.cutoffs;
  modes[name] = { mode: c.mode, shareWithNone: c.zeroShare };
  population[name] = vals.length;
}

const out = {
  generated: new Date().toISOString(),
  method: 'Compared with all NYC tax lots with 3+ residential units (PLUTO). percentile mode: A ≤ 40th percentile, B ≤ 65th, C ≤ 85th, D ≤ 95th, F above. none-or-some mode (used when 40%+ of buildings have none): A = none on record; buildings with any are B ≤ their 50th percentile, C ≤ 75th, D ≤ 90th, F above. Rates are per residential unit (evictions per 100 units; bedbugs = share of unit-years reported infested).',
  windowsYears: WINDOWS,
  population,
  modes,
  cutoffs,
};
await writeFile(new URL('../scoring/thresholds.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
