// Free driving times from the public OSRM server (no traffic) — we scale by a time-of-day factor.
import type { LatLon } from '../engine/geo';
import { distM } from '../engine/geo';

const BASE = 'https://router.project-osrm.org';
const CHUNK = 120;

let chain: Promise<unknown> = Promise.resolve();
/** serialize requests – the public server asks for gentle use */
function queued<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

async function getJson(url: string, timeoutMs = 12000) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('OSRM ' + r.status);
    const j = await r.json();
    if (j.code !== 'Ok') throw new Error('OSRM ' + j.code);
    return j;
  } finally {
    clearTimeout(tm);
  }
}

const fmtPt = (p: LatLon) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;

/** Free-flow seconds from one point to many (dir 'out') or many to one (dir 'in'). NaN when unknown. */
export async function osrmOneToMany(center: LatLon, pts: LatLon[], dir: 'out' | 'in'): Promise<number[]> {
  const out: number[] = new Array(pts.length).fill(NaN);
  for (let i = 0; i < pts.length; i += CHUNK) {
    const chunk = pts.slice(i, i + CHUNK);
    const coords = [center, ...chunk].map(fmtPt).join(';');
    const q = dir === 'out' ? 'sources=0' : 'destinations=0';
    const j = await queued(() => getJson(`${BASE}/table/v1/driving/${coords}?${q}&annotations=duration`));
    if (dir === 'out') {
      const row = j.durations[0] as (number | null)[];
      for (let k = 1; k < row.length; k++) out[i + k - 1] = row[k] ?? NaN;
    } else {
      for (let k = 1; k < j.durations.length; k++) out[i + k - 1] = j.durations[k][0] ?? NaN;
    }
  }
  return out;
}

export interface CarRoute { dur: number; dist: number; coords: LatLon[]; cum: number[] }

export async function osrmRoute(pts: LatLon[]): Promise<CarRoute> {
  const coords = pts.map(fmtPt).join(';');
  const j = await queued(() => getJson(`${BASE}/route/v1/driving/${coords}?overview=full&geometries=geojson&annotations=duration`));
  const r = j.routes[0];
  const c: LatLon[] = r.geometry.coordinates.map((x: number[]) => [x[1], x[0]]);
  const cum = [0];
  const durs: number[] = [];
  for (const leg of r.legs) durs.push(...leg.annotation.duration);
  // geometry for multi-leg routes repeats waypoint coordinates; align by length
  let acc = 0;
  for (let i = 1; i < c.length; i++) {
    acc += durs[i - 1] ?? 0;
    cum.push(acc);
  }
  if (cum[cum.length - 1] > 0) {
    const k = r.duration / cum[cum.length - 1];
    for (let i = 0; i < cum.length; i++) cum[i] *= k;
  }
  return { dur: r.duration, dist: r.distance, coords: c, cum };
}

/** Fallback estimate of free-flow driving seconds from straight-line distance. */
export function estDriveSec(crowM: number) {
  const speed = Math.min(19, 7 + (crowM / 1000) * 2.2);
  return 45 + (crowM * 1.35) / speed;
}

export function estDriveBetween(a: LatLon, b: LatLon) {
  return estDriveSec(distM(a[0], a[1], b[0], b[1]));
}
