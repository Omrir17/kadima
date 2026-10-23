import type {
  BusCandidate, Departure, Itinerary, Leg, LineVariant, Place, PlanRequest, PlanResponse, StopRef, VehicleView,
} from './engine/model';
import type { LatLon } from './engine/geo';

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
worker.onmessage = (e) => {
  const { id, result, error } = e.data;
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error) p.rej(new Error(error)); else p.res(result);
};

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const id = ++seq;
  return new Promise<T>((res, rej) => {
    pending.set(id, { res, rej });
    worker.postMessage({ id, method, args });
  });
}

// ?now=2026-10-25T09:00 simulates the clock for planning (testing aid)
const fakeNow = (() => {
  const v = new URLSearchParams(location.search).get('now');
  return v ? Date.parse(v) : undefined;
})();

export interface NearbyStop { place: Place; dist: number; lines: [string, string][] }

export const api = {
  init: (base: string, version: string) => call<{ days: string[]; built: string; nStops: number }>('init', base, version),
  plan: (req: PlanRequest) => call<PlanResponse>('plan', fakeNow && !req.time ? { ...req, time: fakeNow } : req),
  findBuses: (line: string, pos: LatLon | null, time?: number) => call<BusCandidate[]>('findBuses', line, pos, time ?? fakeNow),
  busStops: (date: string, pattern: number, trip: number) => call<StopRef[]>('busStops', date, pattern, trip),
  departures: (stop: number, time?: number, horizon?: number) => call<Departure[]>('departures', stop, time ?? fakeNow, horizon),
  liveForLeg: (date: string, trip: number, route: number) => call<{ delay: number; pos: number; v: VehicleView } | null>('liveForLeg', date, trip, route),
  vehiclesOnRoute: (date: string, route: number) => call<VehicleView[]>('vehiclesOnRoute', date, route),
  searchStops: (q: string, near?: LatLon) => call<Place[]>('searchStops', q, near),
  nearbyStops: (lat: number, lon: number, radius?: number, limit?: number) => call<NearbyStop[]>('nearbyStops', lat, lon, radius, limit),
  searchLines: (q: string) => call<LineVariant[]>('searchLines', q),
  patternDetail: (route: number, time?: number) => call<{ date: string; pattern: number; stops: Place[]; departures: number[]; nowSec: number; shape: LatLon[] | null } | null>('patternDetail', route, time),
  legGeometry: (legs: Leg[]) => call<LatLon[][]>('legGeometry', legs),
  stopPlace: (stop: number) => call<Place>('stopPlace', stop),
};

export type { Itinerary };
