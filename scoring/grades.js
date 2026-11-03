// NYC Rental Scores — building grading engine.
// Shared by the website (runs in the browser) and the refresh scripts (run in Node 18+).
// Every number comes straight from NYC Open Data; nothing is estimated or invented.

export const SODA = 'https://data.cityofnewyork.us/resource';
export const GEOSEARCH = 'https://geosearch.planninglabs.nyc/v2/search';

// City datasets used (all free, no login).
export const DATASETS = {
  violations: { id: 'wvxf-dwi5', name: 'HPD Housing Maintenance Code Violations' },
  complaints: { id: 'ygpa-z7cr', name: 'HPD Housing Maintenance Code Complaints and Problems' },
  bedbugs: { id: 'wz6d-d3jb', name: 'HPD Bedbug Reporting (filed yearly by owners)' },
  evictions: { id: '6z8x-wfk4', name: 'NYC Marshal Evictions' },
  court: { id: '59kj-x8nc', name: 'HPD Housing Litigations' },
  aep: { id: 'hcir-3275', name: 'HPD Alternative Enforcement Program buildings' },
  pluto: { id: '64uk-42ks', name: 'Primary Land Use Tax Lot Output (PLUTO)' },
};

// How far back each category looks, in years.
export const WINDOWS = { violations: 3, complaints: 2, bedbugs: 3, evictions: 3, court: 5 };

// How much each category counts toward the overall grade.
export const WEIGHTS = { violations: 0.3, bedbugs: 0.2, evictions: 0.2, complaints: 0.15, court: 0.15 };

export const CATEGORY_LABELS = {
  violations: 'Violations',
  bedbugs: 'Bedbugs',
  evictions: 'Evictions',
  complaints: 'Complaints',
  court: 'Landlord record',
};

const BORO_CODES = { 1: 'MN', 2: 'BX', 3: 'BK', 4: 'QN', 5: 'SI' };
const POINTS = { A: 4, B: 3, C: 2, D: 1, F: 0 };

export function sinceDate(years, today = new Date()) {
  const d = new Date(today);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export function splitBBL(bbl) {
  const s = String(bbl).replace(/\D/g, '').slice(0, 10);
  if (s.length !== 10) throw new Error(`Not a valid BBL: ${bbl}`);
  return { boro: s[0], block: String(parseInt(s.slice(1, 6), 10)), lot: String(parseInt(s.slice(6), 10)), bbl: s };
}

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;

export async function soda(dataset, params, { fetchFn = fetch, appToken, timeoutMs = 60000 } = {}) {
  const url = new URL(`${SODA}/${dataset}.json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers = appToken ? { 'X-App-Token': appToken } : {};
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchFn(url, { headers, signal: ctrl?.signal });
      if (res.ok) return await res.json();
      if (res.status < 500 && res.status !== 429) throw new Error(`NYC Open Data ${dataset}: HTTP ${res.status}`);
    } catch (e) {
      if (attempt === 2) throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw new Error(`NYC Open Data ${dataset}: gave up after retries`);
}

// Turn a street address into the city's building IDs (BBL and BIN).
export async function geocode(address, { fetchFn = fetch } = {}) {
  const url = new URL(GEOSEARCH);
  url.searchParams.set('text', address);
  url.searchParams.set('size', '1');
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`Address lookup failed: HTTP ${res.status}`);
  const data = await res.json();
  const f = data.features?.[0];
  const pad = f?.properties?.addendum?.pad;
  if (!f || !pad?.bbl) return null;
  return {
    label: f.properties.label.replace(/, USA$/, ''),
    bbl: pad.bbl,
    bin: pad.bin,
    lat: f.geometry.coordinates[1],
    lon: f.geometry.coordinates[0],
    confidence: f.properties.confidence,
  };
}

// Pull the raw record for one tax lot (BBL) from every dataset.
export async function buildingRecord(bbl, opts = {}) {
  const { boro, block, lot, bbl: id } = splitBBL(bbl);
  const today = opts.today || new Date();
  const s = Object.fromEntries(Object.entries(WINDOWS).map(([k, y]) => [k, sinceDate(y, today)]));
  const call = (ds, p) => soda(DATASETS[ds].id, p, opts);

  // HPD sometimes files violations under its own lot numbers (e.g. lot 9001 for big complexes),
  // so we also match violations by HPD building ID, collected from datasets that list both IDs.
  const idLists = await Promise.all([
    call('complaints', { $select: 'building_id', $where: `bbl=${q(id)}`, $group: 'building_id', $limit: '500' }),
    call('bedbugs', { $select: 'building_id', $where: `bbl=${q(id)}`, $group: 'building_id', $limit: '500' }),
    call('court', { $select: 'buildingid as building_id', $where: `bbl=${q(id)}`, $group: 'buildingid', $limit: '500' }),
  ]);
  const hpdIds = [...new Set(idLists.flat().map((r) => r.building_id).filter((x) => x && x !== '0'))];
  const violPlace = `((boroid=${q(boro)} AND block=${q(block)} AND lot=${q(lot)})${
    hpdIds.length ? ` OR buildingid in (${hpdIds.map(q).join(',')})` : ''
  })`;

  const [pluto, viol, violOpen, comp, bugs, evic, court, aep] = await Promise.all([
    call('pluto', {
      $select: 'address,unitsres,unitstotal,yearbuilt,ownername,numfloors',
      $where: `borough=${q(BORO_CODES[boro])} AND block=${q(block)} AND lot=${q(lot)}`,
      $limit: '1',
    }),
    call('violations', {
      $select: 'class,count(*) as n',
      $where: `${violPlace} AND inspectiondate >= ${q(s.violations)}`,
      $group: 'class',
    }),
    call('violations', {
      $select: 'class,count(*) as n',
      $where: `${violPlace} AND violationstatus='Open'`,
      $group: 'class',
    }),
    call('complaints', {
      $select: "count(distinct complaint_id) as n, count(distinct case(major_category='HEAT/HOT WATER', complaint_id)) as heat",
      $where: `bbl=${q(id)} AND received_date >= ${q(s.complaints)}`,
    }),
    call('bedbugs', {
      $select: 'building_id,filing_date,of_dwelling_units,infested_dwelling_unit_count,eradicated_unit_count,re_infested_dwelling_unit',
      $where: `bbl=${q(id)} AND filing_date >= ${q(s.bedbugs)}`,
      $order: 'filing_date DESC',
      $limit: '500',
    }),
    call('evictions', {
      $select: 'count(*) as n',
      $where: `bbl=${q(id)} AND residential_commercial_ind='Residential' AND executed_date >= ${q(s.evictions)}`,
    }),
    call('court', {
      $select: 'casetype,count(*) as n',
      $where: `bbl=${q(id)} AND caseopendate >= ${q(s.court)} AND caseopendate <= ${q(today.toISOString().slice(0, 10))}`,
      $group: 'casetype',
    }),
    call('aep', { $select: 'aep_start_date,current_status,discharge_date', $where: `bbl=${q(id)}`, $limit: '20' }),
  ]);

  const byClass = Object.fromEntries(viol.map((r) => [r.class, +r.n]));
  const openByClass = Object.fromEntries(violOpen.map((r) => [r.class, +r.n]));
  const courtByType = Object.fromEntries(court.map((r) => [r.casetype, +r.n]));
  const harassment = courtByType['Tenant Action/Harrassment'] || 0;
  const courtTotal = Object.values(courtByType).reduce((a, b) => a + b, 0);

  // Bedbugs: owners file once a year per building. Use each building's filings in the window.
  const bugFilings = bugs.map((r) => ({
    buildingId: r.building_id,
    date: r.filing_date?.slice(0, 10),
    units: +r.of_dwelling_units || 0,
    infested: +r.infested_dwelling_unit_count || 0,
  }));
  const unitYears = bugFilings.reduce((a, r) => a + r.units, 0);
  const infestedUnitYears = bugFilings.reduce((a, r) => a + r.infested, 0);
  const latestUnits = {};
  for (const r of bugFilings) if (!(r.buildingId in latestUnits)) latestUnits[r.buildingId] = r.units;
  const bedbugUnits = Object.values(latestUnits).reduce((a, b) => a + b, 0);

  const p = pluto[0] || {};
  let units = +p.unitsres || 0;
  let unitsSource = 'PLUTO';
  if (!units && bedbugUnits) { units = bedbugUnits; unitsSource = 'HPD bedbug filing'; }
  if (!units) { units = null; unitsSource = 'unknown'; }

  const aepCurrent = aep.some((r) => /active|in program/i.test(r.current_status || '') && !r.discharge_date);

  return {
    bbl: id,
    address: p.address || null,
    units,
    unitsSource,
    yearBuilt: +p.yearbuilt || null,
    owner: p.ownername || null,
    asOf: today.toISOString().slice(0, 10),
    since: s,
    violations: {
      byClass,
      total: Object.values(byClass).reduce((a, b) => a + b, 0),
      weighted: (byClass.A || 0) * 1 + (byClass.B || 0) * 2 + (byClass.C || 0) * 3 + (byClass.I || 0) * 1,
      openByClass,
      openTotal: Object.values(openByClass).reduce((a, b) => a + b, 0),
    },
    complaints: { count: +comp[0]?.n || 0, heat: +comp[0]?.heat || 0 },
    bedbugs: { filings: bugFilings.length, unitYears, infestedUnitYears, yearsWithInfestation: bugFilings.filter((r) => r.infested > 0).length, latestFiling: bugFilings[0]?.date || null },
    evictions: { count: +evic[0]?.n || 0 },
    court: { total: courtTotal, harassment, heat: courtByType['Heat and Hot Water'] || 0, byType: courtByType, weighted: courtTotal + 2 * harassment },
    aep: { ever: aep.length > 0, current: aepCurrent, records: aep },
  };
}

// Convert a raw record into per-unit rates (what the grades are based on).
export function rates(rec) {
  const u = rec.units;
  if (!u) return { violations: null, complaints: null, bedbugs: null, evictions: null, court: null };
  return {
    violations: rec.violations.weighted / u,
    complaints: rec.complaints.count / u,
    bedbugs: rec.bedbugs.unitYears ? rec.bedbugs.infestedUnitYears / rec.bedbugs.unitYears : null,
    evictions: (rec.evictions.count / u) * 100,
    court: rec.court.weighted / u,
  };
}

export function letter(rate, cutoffs) {
  if (rate == null || !cutoffs) return null;
  const [a, b, c, d] = cutoffs;
  if (rate <= a) return 'A';
  if (rate <= b) return 'B';
  if (rate <= c) return 'C';
  if (rate <= d) return 'D';
  return 'F';
}

const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function fmt(n, digits = 2) {
  return n == null ? '—' : Number(n.toFixed(digits)).toLocaleString('en-US');
}

// Grade a record against citywide cutoffs (from scoring/thresholds.json).
export function gradeRecord(rec, thresholds) {
  const r = rates(rec);
  const c = thresholds.cutoffs;
  const g = {};
  for (const k of Object.keys(WEIGHTS)) g[k] = letter(r[k], c[k]);

  // The city's Alternative Enforcement Program targets the most distressed buildings in NYC.
  if (rec.aep.current) g.court = 'F';

  const y = WINDOWS;
  const details = {
    violations: `${plural(rec.violations.total, 'violation')} in ${y.violations} yrs (${rec.violations.byClass.C || 0} most serious, class C); ${rec.violations.openTotal.toLocaleString()} still open. ${fmt(r.violations)} weighted per unit.`,
    bedbugs: rec.bedbugs.filings
      ? `${plural(rec.bedbugs.infestedUnitYears, 'infested apartment')} reported across ${plural(rec.bedbugs.filings, 'yearly owner filing')} in ${y.bedbugs} yrs (${fmt((r.bedbugs || 0) * 100, 1)}% of units).`
      : `No owner bedbug filings in ${y.bedbugs} yrs, so no grade. (Owners of 3+ unit buildings must file yearly.)`,
    evictions: `${plural(rec.evictions.count, 'residential eviction')} by city marshals in ${y.evictions} yrs (${fmt(r.evictions, 1)} per 100 units).`,
    complaints: `${plural(rec.complaints.count, 'tenant complaint')} to HPD in ${y.complaints} yrs, ${rec.complaints.heat.toLocaleString()} about heat or hot water.`,
    court: `${plural(rec.court.total, 'HPD housing-court case')} in ${y.court} yrs, ${rec.court.harassment} alleging harassment.${rec.aep.current ? ' In the city’s program for the most distressed buildings (AEP).' : rec.aep.ever ? ' Previously in the city’s distressed-buildings program (AEP).' : ''}`,
  };

  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(WEIGHTS)) if (g[k]) { sum += POINTS[g[k]] * w; wsum += w; }
  const avg = wsum ? sum / wsum : null;
  let overall = avg == null ? null : avg >= 3.5 ? 'A' : avg >= 2.5 ? 'B' : avg >= 1.5 ? 'C' : avg >= 0.75 ? 'D' : 'F';
  // A single failing category caps the overall grade at C.
  if (overall && 'AB'.includes(overall) && Object.values(g).includes('F')) overall = 'C';

  return { overall, score: avg == null ? null : Math.round((avg / 4) * 100), grades: g, rates: r, details };
}

export async function gradeAddress(address, thresholds, opts = {}) {
  const geo = await geocode(address, opts);
  if (!geo) return { error: 'Could not find that address in NYC.' };
  const rec = await buildingRecord(geo.bbl, opts);
  return { geo, record: rec, ...gradeRecord(rec, thresholds) };
}
