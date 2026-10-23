/// <reference lib="webworker" />
import { loadNet } from './engine/data';
import { Planner } from './engine/planner';
import type { PlanRequest } from './engine/model';

let planner: Planner | null = null;
let ready: Promise<Planner> | null = null;

function init(base: string, version: string) {
  if (ready) return ready;
  const load = async (p: string) => {
    const r = await fetch(base + p + '?v=' + encodeURIComponent(version));
    if (!r.ok) throw new Error('טעינת נתונים נכשלה (' + r.status + ')');
    return r.arrayBuffer();
  };
  ready = loadNet(load).then((net) => (planner = new Planner(net, load)));
  ready.catch(() => (ready = null));
  return ready;
}

const methods: Record<string, (...a: any[]) => any> = {
  async init(base: string, version: string) {
    const p = await init(base, version);
    return { days: p.net.days, built: p.net.built, nStops: p.net.nStops };
  },
  plan(req: PlanRequest) {
    const p = planner!;
    switch (req.mode) {
      case 'pickup': return p.planPickup(req);
      case 'dropoff': return p.planDropoff(req);
      case 'ride': return p.planRide(req);
      case 'onbus': return p.planOnBus(req);
      default: return p.planTransit(req);
    }
  },
  findBuses: (line, pos, time) => planner!.findBuses(line, pos, time),
  busStops: (date, pattern, trip) => planner!.busStops(date, pattern, trip),
  departures: (stop, time, horizon) => planner!.departures(stop, time, horizon),
  liveForLeg: (date, trip, route) => planner!.liveForLeg(date, trip, route),
  vehiclesOnRoute: (date, route) => planner!.vehiclesOnRoute(date, route),
  searchStops: (q, near) => planner!.searchStops(q, near),
  nearbyStops: (lat, lon, radius, limit) => planner!.nearbyStops(lat, lon, radius, limit),
  searchLines: (q) => planner!.searchLines(q),
  patternDetail: (route, time) => planner!.patternDetail(route, time),
  legGeometry: (legs) => planner!.legGeometry(legs),
  stopPlace: (s) => planner!.stopPlace(s),
};

self.onmessage = async (e: MessageEvent) => {
  const { id, method, args } = e.data;
  try {
    if (method !== 'init' && !planner) {
      if (!ready) throw new Error('not initialised');
      await ready;
    }
    const result = await methods[method](...args);
    (self as unknown as Worker).postMessage({ id, result });
  } catch (err: any) {
    (self as unknown as Worker).postMessage({ id, error: String(err?.message || err) });
  }
};
