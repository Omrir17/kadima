import { Grid } from './geo';

export type RouteRow = [gtfsId: number, short: string, from: string, to: string, agency: number, type: number, color: string, desc: string];

export interface NetJson {
  v: number;
  built: string;
  days: string[];
  shapeBuckets: number;
  agencies: Record<string, string>;
  routes: RouteRow[];
  headsigns: string[];
  stops: { code: number[]; name: string[]; city: string[]; lat: number[]; lon: number[] };
}

export interface Net extends NetJson {
  nStops: number;
  lat: Float64Array;
  lon: Float64Array;
  grid: Grid;
  /** footpaths (CSR): neighbours within 400m, distance in walking meters */
  footOff: Uint32Array;
  footTo: Uint32Array;
  footDist: Uint16Array;
  routeByGtfs: Map<number, number>;
}

export interface Day {
  date: string;
  nPat: number;
  nTrip: number;
  patRoute: Uint32Array;
  patShape: Int32Array;
  patHead: Uint32Array;
  patStopOff: Uint32Array;
  patTripOff: Uint32Array;
  patStops: Uint32Array;
  patTimeOff: Uint32Array;
  tripRef: Uint32Array;
  tripPat: Uint32Array;
  times: Int32Array;
  /** stop -> (pattern, position) list (CSR) */
  spOff: Uint32Array;
  spPat: Uint32Array;
  spPos: Uint16Array;
  /** routeIdx -> patterns */
  routePats: Map<number, number[]>;
  /** tripRef -> trip index */
  tripByRef: Map<number, number>;
}

export type Loader = (path: string) => Promise<ArrayBuffer>;

export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const u8 = new Uint8Array(buf);
  if (u8[0] !== 0x1f || u8[1] !== 0x8b) return buf; // already decoded by the server
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return await new Response(stream).arrayBuffer();
}

export const WALK_FACTOR = 1.3; // crow-flight -> street distance
export const FOOT_RADIUS = 400;

export async function loadNet(load: Loader): Promise<Net> {
  const raw = await gunzip(await load('net.json.gz'));
  const j = JSON.parse(new TextDecoder().decode(raw)) as NetJson;
  const n = j.stops.lat.length;
  const lat = Float64Array.from(j.stops.lat);
  const lon = Float64Array.from(j.stops.lon);
  const grid = new Grid(lat, lon);
  // footpaths
  const off = new Uint32Array(n + 1);
  const to: number[] = [];
  const dist: number[] = [];
  for (let s = 0; s < n; s++) {
    off[s] = to.length;
    for (const [o, d] of grid.near(lat[s], lon[s], FOOT_RADIUS, 40)) {
      if (o === s) continue;
      to.push(o);
      dist.push(Math.round(d * WALK_FACTOR));
    }
  }
  off[n] = to.length;
  const routeByGtfs = new Map<number, number>();
  j.routes.forEach((r, i) => routeByGtfs.set(r[0], i));
  return {
    ...j, nStops: n, lat, lon, grid,
    footOff: off, footTo: Uint32Array.from(to), footDist: Uint16Array.from(dist), routeByGtfs,
  };
}

export async function loadDay(load: Loader, net: Net, date: string): Promise<Day> {
  const buf = await gunzip(await load(`days/${date}.bin.gz`));
  const head = new Uint32Array(buf, 0, 8);
  if (head[0] !== 0x4b44494d) throw new Error('bad day file');
  const nPat = head[2], nTrip = head[3], nPS = head[4], nDelta = head[5];
  let o = 8 * 4;
  const u32 = (len: number) => { const a = new Uint32Array(buf, o, len); o += len * 4; return a; };
  const i32 = (len: number) => { const a = new Int32Array(buf, o, len); o += len * 4; return a; };
  const patRoute = u32(nPat);
  const patShape = i32(nPat);
  const patHead = u32(nPat);
  const patStopOff = u32(nPat + 1);
  const patTripOff = u32(nPat + 1);
  const patStops = u32(nPS);
  const tripStart = i32(nTrip);
  const tripRef = u32(nTrip);
  const deltas = new Uint16Array(buf, o, nDelta);

  // expand times
  const patTimeOff = new Uint32Array(nPat + 1);
  let total = 0;
  for (let p = 0; p < nPat; p++) {
    patTimeOff[p] = total;
    total += (patTripOff[p + 1] - patTripOff[p]) * (patStopOff[p + 1] - patStopOff[p]);
  }
  patTimeOff[nPat] = total;
  const times = new Int32Array(total);
  const tripPat = new Uint32Array(nTrip);
  let ti = 0, di = 0;
  for (let p = 0; p < nPat; p++) {
    const ns = patStopOff[p + 1] - patStopOff[p];
    for (let t = patTripOff[p]; t < patTripOff[p + 1]; t++) {
      tripPat[t] = p;
      let v = tripStart[t];
      times[ti++] = v;
      for (let k = 1; k < ns; k++) { v += deltas[di++]; times[ti++] = v; }
    }
  }

  // stop -> patterns index
  const cnt = new Uint32Array(net.nStops + 1);
  for (let i = 0; i < nPS; i++) cnt[patStops[i]]++;
  const spOff = new Uint32Array(net.nStops + 1);
  for (let s = 0; s < net.nStops; s++) spOff[s + 1] = spOff[s] + cnt[s];
  const fill = spOff.slice(0, net.nStops);
  const spPat = new Uint32Array(nPS);
  const spPos = new Uint16Array(nPS);
  const routePats = new Map<number, number[]>();
  for (let p = 0; p < nPat; p++) {
    for (let i = patStopOff[p]; i < patStopOff[p + 1]; i++) {
      const s = patStops[i];
      const k = fill[s]++;
      spPat[k] = p;
      spPos[k] = i - patStopOff[p];
    }
    const r = patRoute[p];
    let l = routePats.get(r);
    if (!l) routePats.set(r, (l = []));
    l.push(p);
  }
  const tripByRef = new Map<number, number>();
  for (let t = 0; t < nTrip; t++) tripByRef.set(tripRef[t], t);

  return {
    date, nPat, nTrip, patRoute, patShape, patHead, patStopOff, patTripOff, patStops, patTimeOff,
    tripRef, tripPat, times, spOff, spPat, spPos, routePats, tripByRef,
  };
}

/** time of trip t at position i of its pattern */
export function tripTime(day: Day, t: number, i: number) {
  const p = day.tripPat[t];
  const ns = day.patStopOff[p + 1] - day.patStopOff[p];
  return day.times[day.patTimeOff[p] + (t - day.patTripOff[p]) * ns + i];
}

export function patLen(day: Day, p: number) {
  return day.patStopOff[p + 1] - day.patStopOff[p];
}

export function patStop(day: Day, p: number, i: number) {
  return day.patStops[day.patStopOff[p] + i];
}

const shapeCache = new Map<number, Promise<Record<string, string>>>();
export function loadShapeBucket(load: Loader, net: Net, shape: number) {
  const b = shape % net.shapeBuckets;
  let pr = shapeCache.get(b);
  if (!pr) {
    pr = load(`shapes/${String(b).padStart(3, '0')}.json.gz`)
      .then(gunzip)
      .then((buf) => JSON.parse(new TextDecoder().decode(buf)));
    shapeCache.set(b, pr);
    pr.catch(() => shapeCache.delete(b));
  }
  return pr;
}
