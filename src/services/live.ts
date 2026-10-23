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
    const key = v.vehicleRef + ':' + v.tripRef;
    const prev = byVehicle.get(key);
    if (!prev || prev.recordedAt < v.recordedAt) byVehicle.set(key, v);
  }
  return [...byVehicle.values()];
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

/** Latest positions for one GTFS route (line_ref). Cached for 20s. */
export function vehiclesForRoute(gtfsRouteId: number, windowSec = 240): Promise<Vehicle[]> {
  const key = 'r' + gtfsRouteId;
  const c = cache.get(key);
  if (c && Date.now() - c.at < 20000) return c.data;
  const url = `${BASE}/siri_vehicle_locations/list?limit=300&siri_routes__line_ref=${gtfsRouteId}&${timeWindow(windowSec)}`;
  const data = fetchJson(url).then(parse);
  cache.set(key, { at: Date.now(), data });
  data.catch(() => cache.delete(key));
  return data;
}

/** All vehicles in a bounding box (used for "buses near me"). */
export function vehiclesInBox(minLat: number, minLon: number, maxLat: number, maxLon: number, windowSec = 150): Promise<Vehicle[]> {
  const url = `${BASE}/siri_vehicle_locations/list?limit=1000&${timeWindow(windowSec)}` +
    `&lat__greater_or_equal=${minLat}&lat__lower_or_equal=${maxLat}&lon__greater_or_equal=${minLon}&lon__lower_or_equal=${maxLon}`;
  return fetchJson(url).then(parse);
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
