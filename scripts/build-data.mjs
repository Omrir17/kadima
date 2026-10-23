// Kadima data builder: converts the Israeli GTFS feed into compact files the app downloads.
//   node scripts/build-data.mjs <gtfsDir> <outDir> [days=8]
// Output:
//   net.json.gz            stops, routes, agencies, headsigns, list of available days
//   days/YYYY-MM-DD.bin.gz per-service-day timetable (patterns + trips), incl. previous-day trips running past midnight
//   shapes/NN.json.gz      route shapes (encoded polylines), bucketed by shape index
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';

const [gtfsDir, outDir, daysArg] = process.argv.slice(2);
if (!gtfsDir || !outDir) {
  console.error('usage: node build-data.mjs <gtfsDir> <outDir> [days]');
  process.exit(1);
}
const NUM_DAYS = Number(daysArg || 8);
const SHAPE_BUCKETS = 128;
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

// ---------- CSV helpers ----------
function parseLine(line) {
  if (line.indexOf('"') < 0) return line.split(',');
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

async function eachRow(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(gtfsDir, file)), crlfDelay: Infinity });
  let header = null;
  let n = 0;
  for await (let line of rl) {
    if (!header) {
      header = parseLine(line.replace(/^﻿/, ''));
      fn.header?.(header);
      continue;
    }
    if (!line) continue;
    fn(parseLine(line), header);
    n++;
  }
  return n;
}

function colIndex(header, names) {
  const o = {};
  for (const n of names) o[n] = header.indexOf(n);
  return o;
}

const toSec = (s) => {
  const a = s.split(':');
  return (+a[0]) * 3600 + (+a[1]) * 60 + (+a[2] || 0);
};

// ---------- dates (Israel local) ----------
function israelToday() {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(new Date()); // YYYY-MM-DD
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ymdNum = (ymd) => Number(ymd.replace(/-/g, ''));
const weekday = (ymd) => new Date(ymd + 'T12:00:00Z').getUTCDay(); // 0=Sun

// Days we need: day[-1] (for after-midnight trips) .. day[NUM_DAYS-1]
const firstDay = process.env.KADIMA_START_DAY || israelToday();
const days = [];
for (let i = 0; i < NUM_DAYS; i++) days.push(addDays(firstDay, i));
const allDays = [addDays(firstDay, -1), ...days]; // index 0 = previous day
log('building days', days.join(', '));

// ---------- calendar ----------
// service_id -> bitmask over allDays
const serviceMask = new Map();
{
  let c;
  await eachRow('calendar.txt', Object.assign((r) => {
    let mask = 0;
    const s = +r[c.start_date], e = +r[c.end_date];
    const dowCols = [c.sunday, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday];
    allDays.forEach((d, i) => {
      const n = ymdNum(d);
      if (n >= s && n <= e && r[dowCols[weekday(d)]] === '1') mask |= 1 << i;
    });
    if (mask) serviceMask.set(r[c.service_id], mask);
  }, { header: (h) => (c = colIndex(h, ['service_id', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'start_date', 'end_date'])) }));
  if (fs.existsSync(path.join(gtfsDir, 'calendar_dates.txt'))) {
    await eachRow('calendar_dates.txt', Object.assign((r) => {
      const i = allDays.findIndex((d) => ymdNum(d) === +r[c.date]);
      if (i < 0) return;
      let m = serviceMask.get(r[c.service_id]) || 0;
      if (r[c.exception_type] === '1') m |= 1 << i; else m &= ~(1 << i);
      serviceMask.set(r[c.service_id], m);
    }, { header: (h) => (c = colIndex(h, ['service_id', 'date', 'exception_type'])) }));
  }
  log('services active in window:', serviceMask.size);
}

// ---------- agencies ----------
const agencies = {};
{
  let c;
  await eachRow('agency.txt', Object.assign((r) => { agencies[r[c.agency_id]] = r[c.agency_name]; },
    { header: (h) => (c = colIndex(h, ['agency_id', 'agency_name'])) }));
}

// ---------- stops ----------
const stopIdx = new Map();
const stops = { id: [], code: [], name: [], city: [], lat: [], lon: [] };
{
  let c;
  await eachRow('stops.txt', Object.assign((r) => {
    if (r[c.location_type] && r[c.location_type] !== '0') return;
    stopIdx.set(r[c.stop_id], stops.id.length);
    stops.id.push(r[c.stop_id]);
    stops.code.push(Number(r[c.stop_code]) || 0);
    stops.name.push(r[c.stop_name].replace(/''/g, '"'));
    const m = /עיר:\s*(.*?)\s*(רציף:|$)/.exec(r[c.stop_desc] || '');
    stops.city.push(m ? m[1].trim() : '');
    stops.lat.push(Math.round(+r[c.stop_lat] * 1e6) / 1e6);
    stops.lon.push(Math.round(+r[c.stop_lon] * 1e6) / 1e6);
  }, { header: (h) => (c = colIndex(h, ['stop_id', 'stop_code', 'stop_name', 'stop_desc', 'stop_lat', 'stop_lon', 'location_type'])) }));
  log('stops:', stops.id.length);
}

// ---------- routes ----------
const routeIdx = new Map();
const routes = []; // [gtfsId, short, from, to, agencyId, type, color, desc]
{
  let c;
  const side = (s) => {
    // "stop name-city" -> {stop, city}; city is after the last '-'
    s = s.trim().replace(/''/g, '"');
    const i = s.lastIndexOf('-');
    return i > 0 ? [s.slice(0, i).trim(), s.slice(i + 1).trim()] : [s, ''];
  };
  await eachRow('routes.txt', Object.assign((r) => {
    const long = r[c.route_long_name] || '';
    let [a, b] = long.split('<->');
    // strip the trailing direction/alternative code, e.g. "-10", "-1#", "-3ק"
    b = (b || '').replace(/-[0-9A-Za-z#֐-׿]{1,4}#?$/, (m) => (/\d/.test(m) ? '' : m));
    const A = side(a || ''), B = side(b || '');
    routeIdx.set(r[c.route_id], routes.length);
    routes.push([
      Number(r[c.route_id]),
      r[c.route_short_name] || '',
      A[0] + (A[1] ? ', ' + A[1] : ''),
      B[0] + (B[1] ? ', ' + B[1] : ''),
      Number(r[c.agency_id]),
      Number(r[c.route_type]),
      r[c.route_color] || '',
      r[c.route_desc] || '',
    ]);
  }, { header: (h) => (c = colIndex(h, ['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_desc', 'route_type', 'route_color'])) }));
  log('routes:', routes.length);
}

// ---------- trips ----------
const tripInfo = new Map(); // trip_id -> {route, mask, headsign, shape}
const headsignIdx = new Map();
const headsigns = [];
const internHeadsign = (h) => {
  h = (h || '').replace(/_/g, ' - ').replace(/''/g, '"').trim();
  let i = headsignIdx.get(h);
  if (i === undefined) { i = headsigns.length; headsigns.push(h); headsignIdx.set(h, i); }
  return i;
};
{
  let c;
  await eachRow('trips.txt', Object.assign((r) => {
    const mask = serviceMask.get(r[c.service_id]);
    if (!mask) return;
    const route = routeIdx.get(r[c.route_id]);
    if (route === undefined) return;
    tripInfo.set(r[c.trip_id], { route, mask, headsign: internHeadsign(r[c.trip_headsign]), shape: r[c.shape_id] || '' });
  }, { header: (h) => (c = colIndex(h, ['route_id', 'service_id', 'trip_id', 'trip_headsign', 'shape_id'])) }));
  log('trips in window:', tripInfo.size);
}

// ---------- stop_times ----------
// Pattern = route + exact stop sequence.
const patternKeyIdx = new Map();
const patterns = []; // {route, stops: Uint32Array, shape, headsign}
const tripsOut = []; // {pattern, times: Int32Array, ref, mask}
const shapeIdIdx = new Map();
const shapeIds = [];
{
  let c;
  let curTrip = null, curRows = [];
  const seen = new Set();
  const flush = () => {
    if (curTrip === null) return;
    const info = tripInfo.get(curTrip);
    if (info && curRows.length >= 2) {
      curRows.sort((a, b) => a[0] - b[0]);
      const st = new Uint32Array(curRows.length);
      const tm = new Int32Array(curRows.length);
      for (let i = 0; i < curRows.length; i++) { st[i] = curRows[i][1]; tm[i] = curRows[i][2]; }
      const key = info.route + ':' + st.join(',');
      let p = patternKeyIdx.get(key);
      if (p === undefined) {
        p = patterns.length;
        patternKeyIdx.set(key, p);
        let sh = -1;
        if (info.shape) {
          sh = shapeIdIdx.get(info.shape);
          if (sh === undefined) { sh = shapeIds.length; shapeIds.push(info.shape); shapeIdIdx.set(info.shape, sh); }
        }
        patterns.push({ route: info.route, stops: st, shape: sh, headsign: info.headsign });
      }
      tripsOut.push({ pattern: p, times: tm, ref: parseInt(curTrip, 10) || 0, mask: info.mask });
    }
    if (seen.has(curTrip)) throw new Error('stop_times not grouped by trip: ' + curTrip);
    seen.add(curTrip);
    curRows = [];
  };
  let rows = 0;
  await eachRow('stop_times.txt', Object.assign((r) => {
    const tid = r[c.trip_id];
    if (tid !== curTrip) { flush(); curTrip = tid; }
    if (!tripInfo.has(tid)) return;
    const s = stopIdx.get(r[c.stop_id]);
    if (s === undefined) return;
    curRows.push([+r[c.stop_sequence], s, toSec(r[c.arrival_time] || r[c.departure_time])]);
    if (++rows % 5e6 === 0) log('  stop_times rows', rows);
  }, { header: (h) => (c = colIndex(h, ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'])) }));
  flush();
  log('patterns:', patterns.length, 'trips:', tripsOut.length);
}

// ---------- per-day files ----------
fs.mkdirSync(path.join(outDir, 'days'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'shapes'), { recursive: true });
const usedShapes = new Set();
const dayStats = [];

for (let di = 0; di < days.length; di++) {
  const dayBit = 1 << (di + 1);
  const prevBit = 1 << di;
  // collect trips for the day: [pattern, start-shifted times, ref]
  const byPattern = new Map();
  for (const t of tripsOut) {
    let shift = null;
    if (t.mask & dayBit) shift = 0;
    else if ((t.mask & prevBit) && t.times[t.times.length - 1] >= 86400) shift = -86400;
    if (shift === null) continue;
    let arr = byPattern.get(t.pattern);
    if (!arr) byPattern.set(t.pattern, (arr = []));
    arr.push({ t, shift });
  }
  // build FIFO sub-patterns
  const outPatterns = []; // {p, trips:[{t,shift}]}
  for (const [p, list] of byPattern) {
    list.sort((a, b) => (a.t.times[0] + a.shift) - (b.t.times[0] + b.shift));
    const groups = [];
    for (const it of list) {
      let placed = false;
      for (const g of groups) {
        const last = g[g.length - 1];
        let ok = true;
        for (let i = 0; i < it.t.times.length; i++) {
          if (it.t.times[i] + it.shift < last.t.times[i] + last.shift) { ok = false; break; }
        }
        if (ok) { g.push(it); placed = true; break; }
      }
      if (!placed) groups.push([it]);
    }
    for (const g of groups) outPatterns.push({ p, trips: g });
  }
  // sort patterns by route for nicer locality
  outPatterns.sort((a, b) => patterns[a.p].route - patterns[b.p].route || a.p - b.p);

  const nPat = outPatterns.length;
  let nPatStops = 0, nTrip = 0, nDelta = 0;
  for (const op of outPatterns) {
    const n = patterns[op.p].stops.length;
    nPatStops += n;
    nTrip += op.trips.length;
    nDelta += op.trips.length * (n - 1);
  }
  const HEADER = 8;
  const u32len = HEADER + nPat * 3 + (nPat + 1) * 2 + nPatStops + nTrip * 2;
  const buf = Buffer.alloc(u32len * 4 + nDelta * 2);
  const u32 = new Uint32Array(buf.buffer, buf.byteOffset, u32len);
  const i32 = new Int32Array(buf.buffer, buf.byteOffset, u32len);
  const u16 = new Uint16Array(buf.buffer, buf.byteOffset + u32len * 4, nDelta);
  u32[0] = 0x4b44494d; u32[1] = 1; u32[2] = nPat; u32[3] = nTrip; u32[4] = nPatStops; u32[5] = nDelta;
  let o = HEADER;
  const oRoute = o; o += nPat;
  const oShape = o; o += nPat;
  const oHead = o; o += nPat;
  const oStopOff = o; o += nPat + 1;
  const oTripOff = o; o += nPat + 1;
  const oStops = o; o += nPatStops;
  const oTripStart = o; o += nTrip;
  const oTripRef = o; o += nTrip;
  let ps = 0, tr = 0, dl = 0;
  outPatterns.forEach((op, i) => {
    const P = patterns[op.p];
    u32[oRoute + i] = P.route;
    i32[oShape + i] = P.shape;
    if (P.shape >= 0) usedShapes.add(P.shape);
    u32[oHead + i] = P.headsign;
    u32[oStopOff + i] = ps;
    u32[oTripOff + i] = tr;
    for (const s of P.stops) u32[oStops + ps++] = s;
    for (const { t, shift } of op.trips) {
      i32[oTripStart + tr] = t.times[0] + shift;
      u32[oTripRef + tr] = t.ref;
      tr++;
      for (let k = 1; k < t.times.length; k++) {
        const d = t.times[k] - t.times[k - 1];
        u16[dl++] = Math.max(0, Math.min(65535, d));
      }
    }
  });
  u32[oStopOff + nPat] = ps;
  u32[oTripOff + nPat] = tr;
  const gz = zlib.gzipSync(buf, { level: 9 });
  fs.writeFileSync(path.join(outDir, 'days', days[di] + '.bin.gz'), gz);
  dayStats.push({ day: days[di], patterns: nPat, trips: nTrip, bytes: gz.length });
  log('day', days[di], 'patterns', nPat, 'trips', nTrip, 'gz', (gz.length / 1e6).toFixed(2) + 'MB');
}

// ---------- shapes ----------
{
  const wanted = new Map(); // gtfs shape id -> idx
  for (const i of usedShapes) wanted.set(shapeIds[i], i);
  const pts = new Map(); // idx -> [[seq,lat,lon]]
  let c;
  await eachRow('shapes.txt', Object.assign((r) => {
    const i = wanted.get(r[c.shape_id]);
    if (i === undefined) return;
    let a = pts.get(i);
    if (!a) pts.set(i, (a = []));
    a.push([+r[c.shape_pt_sequence], +r[c.shape_pt_lat], +r[c.shape_pt_lon]]);
  }, { header: (h) => (c = colIndex(h, ['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence'])) }));
  const buckets = Array.from({ length: SHAPE_BUCKETS }, () => ({}));
  for (const [i, a] of pts) {
    a.sort((x, y) => x[0] - y[0]);
    const simp = simplify(a.map((p) => [p[1], p[2]]), 0.00006);
    buckets[i % SHAPE_BUCKETS][i] = encodePolyline(simp);
  }
  let total = 0;
  buckets.forEach((b, k) => {
    const gz = zlib.gzipSync(JSON.stringify(b), { level: 9 });
    total += gz.length;
    fs.writeFileSync(path.join(outDir, 'shapes', String(k).padStart(3, '0') + '.json.gz'), gz);
  });
  log('shapes:', pts.size, 'gz total', (total / 1e6).toFixed(2) + 'MB');
}

// ---------- network file ----------
{
  const net = {
    v: 1,
    built: new Date().toISOString(),
    days,
    shapeBuckets: SHAPE_BUCKETS,
    agencies,
    routes,
    headsigns,
    stops: { code: stops.code, name: stops.name, city: stops.city, lat: stops.lat, lon: stops.lon },
    dayStats,
  };
  const gz = zlib.gzipSync(JSON.stringify(net), { level: 9 });
  fs.writeFileSync(path.join(outDir, 'net.json.gz'), gz);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ built: net.built, days }));
  // remove stale day files
  for (const f of fs.readdirSync(path.join(outDir, 'days'))) {
    if (!days.includes(f.replace('.bin.gz', ''))) fs.unlinkSync(path.join(outDir, 'days', f));
  }
  log('net.json.gz', (gz.length / 1e6).toFixed(2) + 'MB');
}
log('done');

// ---------- geometry helpers ----------
function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol * tol && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

function encodePolyline(points) {
  let out = '', plat = 0, plon = 0;
  const enc = (v) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5), b = Math.round(lon * 1e5);
    out += enc(a - plat) + enc(b - plon);
    plat = a; plon = b;
  }
  return out;
}
