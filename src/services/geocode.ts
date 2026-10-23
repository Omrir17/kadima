import type { Place } from '../engine/model';

// Photon (Komoot) – free OSM geocoder with autocomplete.
const BASE = 'https://photon.komoot.io';
const BBOX = '34.2,29.45,35.95,33.35';

function label(p: any): { name: string; sub: string } {
  const pr = p.properties || {};
  const street = pr.street ? pr.street + (pr.housenumber ? ' ' + pr.housenumber : '') : '';
  const name = pr.name || street || pr.city || '';
  const sub = [pr.name && street && pr.name !== street ? street : '', pr.city || pr.county || ''].filter(Boolean).join(', ');
  return { name, sub };
}

export async function geocode(q: string, near?: [number, number], signal?: AbortSignal): Promise<Place[]> {
  const bias = near ? `&lat=${near[0]}&lon=${near[1]}` : '';
  const r = await fetch(`${BASE}/api/?q=${encodeURIComponent(q)}&lang=default&limit=8&bbox=${BBOX}${bias}`, { signal });
  if (!r.ok) return [];
  const j = await r.json();
  const out: Place[] = [];
  for (const f of j.features || []) {
    const { name, sub } = label(f);
    if (!name) continue;
    const [lon, lat] = f.geometry.coordinates;
    if (out.some((o) => o.name === name && o.sub === sub)) continue;
    out.push({ name, sub, lat, lon });
  }
  return out;
}

export async function reverseGeocode(lat: number, lon: number): Promise<string> {
  try {
    const r = await fetch(`${BASE}/reverse?lat=${lat}&lon=${lon}&lang=default&limit=1`);
    const j = await r.json();
    const f = j.features?.[0];
    if (!f) return 'נקודה במפה';
    const { name, sub } = label(f);
    return name ? (sub && !name.includes(sub) ? `${name}, ${sub.split(', ').pop()}` : name) : 'נקודה במפה';
  } catch {
    return 'נקודה במפה';
  }
}
