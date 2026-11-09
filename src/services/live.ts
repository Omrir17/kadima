// Live vehicle positions from the Open Bus Stride project (Hasadna). Data lags ~1-2 minutes.
const BASE = 'https://open-bus-stride-api.hasadna.org.il';

export interface Vehicle {
  lineRef: number; // == GTFS route_id
  tripRef: number; // == numeric prefix of GTFS trip_id
  lat: number;
  lon: number;
  bearing: number;
  velocity: number;
  recordedAt: number; // epoch ms
  vehicleRef: string;
}

// NOTE: the API is only fast when both ends of the time window are given.
function timeWindow(windowSec: number) {
  const from = new Date(Date.now() - windowSec * 1000).toISOString();
  const to = new Date(Date.now() + 120 * 1000).toISOString();
  return `recorded_at_time_from=${encodeURIComponent(from)}&recorded_at_time_to=${encodeURIComponent(to)}`;
}

const cache = new Map<string, { at: number; data: Promise<Vehicle[]> }>();

function parse(rows: any[]): Vehicle[] {
  // the window holds several snapshots: keep only each bus's newest report
  const byVehicle = new Map<string, Vehicle>();
  for (const r of rows) {
    const jr = String(r.siri_ride__journey_ref || '');
    const m = /(\d+)$/.exec(jr);
    const v: Vehicle = {
      lineRef: Number(r.siri_route__line_ref),
      tripRef: m ? Number(m[1]) : 0,
      lat: r.lat,
      lon: r.lon,
      bearing: r.bearing ?? 0,
      velocity: r.velocity ?? 0,
      recordedAt: Date.parse(r.recorded_at_time),
      vehicleRef: String(r.siri_ride__vehicle_ref || jr),
    };
    if (!v.lat || !v.lon) continue;
    const prev = byVehicle.get(v.vehicleRef);
    if (!prev || prev.recordedAt < v.recordedAt) byVehicle.set(v.vehicleRef, v);
  }
  const fresh = Date.now() - 12 * 60e3;
  return [...byVehicle.values()].filter((v) => v.recordedAt > fresh);
}

async function fetchJson(url: string, timeoutMs = 10000) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('live ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(tm);
  }
}

/**
 * Latest positions for one GTFS route (line_ref). Cached for 20s.
 * The open feed is published ~2-5 minutes late, so we look back 10 minutes and
 * the planner moves each bus forward along its route (see Planner.vehicleNow).
 */
export function vehiclesForRoute(gtfsRouteId: number, windowSec = 600): Promise<Vehicle[]> {
  const key = 'r' + gtfsRouteId;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 20000) return c.data;
  const url = `${BASE}/siri_vehicle_locations/list?limit=300&siri_routes__line_ref=${gtfsRouteId}&${timeWindow(windowSec)}`;
  const data = fetchJson(url).then(parse);
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  return data;
}

export async function vehiclesForRoutes(ids: number[]): Promise<Vehicle[]> {
  const out: Vehicle[] = [];
  const uniq = [...new Set(ids)];
  let i = 0;
  const worker = async () => {
    while (i < uniq.length) {
      const id = uniq[i++];
      try { out.push(...(await vehiclesForRoute(id))); } catch { /* ignore single failures */ }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  return out;
}
