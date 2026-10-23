// Traffic-aware driving times from TomTom (free tier: ~2,500 requests/day).
// Used only to re-check the few car legs the user actually sees.
import type { LatLon } from '../engine/geo';
import { hm, israelParts } from '../engine/time';

function israelLocal(ms: number) {
  const p = israelParts(ms);
  return `${p.ymd}T${hm(p.sec)}:00`;
}

const BASE = 'https://api.tomtom.com/routing/1/calculateRoute';

export interface TrafficRoute { sec: number; noTrafficSec: number; meters: number }

const cache = new Map<string, Promise<TrafficRoute>>();
let active = 0;
const waiters: (() => void)[] = [];

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  // TomTom allows ~5 requests/second; keep at most 2 in flight
  if (active >= 2) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** Driving time through the given points, with traffic at `departMs` (epoch ms). */
export function trafficRoute(key: string, pts: LatLon[], departMs: number): Promise<TrafficRoute> {
  const soon = departMs - Date.now() < 2 * 60e3;
  // RFC 3339 local time without offset: TomTom then assumes the origin's time zone (Israel)
  const bucket = soon ? 'now' : israelLocal(Math.round(departMs / 300e3) * 300e3);
  const locs = pts.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(':');
  const id = locs + '@' + bucket;
  const hit = cache.get(id);
  if (hit) return hit;
  const url = `${BASE}/${locs}/json?key=${encodeURIComponent(key)}&traffic=true&travelMode=car&routeType=fastest` +
    `&departAt=${encodeURIComponent(bucket)}&computeTravelTimeFor=all&routeRepresentation=summaryOnly`;
  const p = slot(async () => {
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) {
        if (r.status === 403 || r.status === 401) throw new Error('מפתח TomTom לא תקין, או ש-Routing API לא מופעל עליו');
        if (r.status === 429) throw new Error('נגמרה המכסה היומית של TomTom');
        let detail = '';
        try { const j = await r.json(); detail = j?.detailedError?.message || j?.error?.description || ''; } catch { /* not json */ }
        throw new Error(`TomTom ${r.status}${detail ? ': ' + detail : ''}`);
      }
      const j = await r.json();
      const s = j.routes?.[0]?.summary;
      if (!s) throw new Error('TomTom: no route');
      return { sec: s.travelTimeInSeconds, noTrafficSec: s.noTrafficTravelTimeInSeconds ?? s.travelTimeInSeconds, meters: s.lengthInMeters };
    } finally {
      clearTimeout(tm);
    }
  });
  cache.set(id, p);
  p.catch(() => cache.delete(id));
  return p;
}

/** Quick validity check for the settings screen. */
export async function testKey(key: string): Promise<string> {
  const r = await trafficRoute(key, [[32.0853, 34.7818], [32.0889, 34.8864]], Date.now());
  return `עובד. תל אביב ← פתח תקווה עכשיו: ${Math.round(r.sec / 60)} דק' (בלי פקקים: ${Math.round(r.noTrafficSec / 60)})`;
}
