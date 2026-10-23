export type LatLon = [number, number];

const R = 6371000;
const toRad = Math.PI / 180;

export function distM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  // Equirectangular approximation; accurate enough at Israel's scale.
  const x = (lon2 - lon1) * toRad * Math.cos(((lat1 + lat2) / 2) * toRad);
  const y = (lat2 - lat1) * toRad;
  return Math.sqrt(x * x + y * y) * R;
}

// Spatial grid over stops (~550m cells)
const CELL_LAT = 0.005;
const CELL_LON = 0.006;

export class Grid {
  private cells = new Map<number, number[]>();
  constructor(private lat: Float64Array, private lon: Float64Array) {
    for (let i = 0; i < lat.length; i++) {
      const k = this.key(lat[i], lon[i]);
      let c = this.cells.get(k);
      if (!c) this.cells.set(k, (c = []));
      c.push(i);
    }
  }
  private key(la: number, lo: number) {
    return Math.floor(la / CELL_LAT) * 100000 + Math.floor(lo / CELL_LON);
  }
  /** Returns [stopIndex, distanceMeters] within radius, sorted by distance. */
  near(la: number, lo: number, radiusM: number, limit = Infinity): [number, number][] {
    const dr = Math.ceil(radiusM / 550) + 1;
    const r0 = Math.floor(la / CELL_LAT), c0 = Math.floor(lo / CELL_LON);
    const out: [number, number][] = [];
    for (let r = r0 - dr; r <= r0 + dr; r++) {
      for (let c = c0 - dr; c <= c0 + dr; c++) {
        const cell = this.cells.get(r * 100000 + c);
        if (!cell) continue;
        for (const s of cell) {
          const d = distM(la, lo, this.lat[s], this.lon[s]);
          if (d <= radiusM) out.push([s, d]);
        }
      }
    }
    out.sort((a, b) => a[1] - b[1]);
    return out.length > limit ? out.slice(0, limit) : out;
  }
}

export function decodePolyline(str: string): LatLon[] {
  const out: LatLon[] = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let b, shift = 0, res = 0;
      do {
        b = str.charCodeAt(i++) - 63;
        res |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([lat / 1e5, lon / 1e5]);
  }
  return out;
}

/** Project point onto polyline; returns index of segment start, fraction along it and distance. */
export function projectOnLine(pts: LatLon[], la: number, lo: number) {
  let best = { seg: 0, frac: 0, dist: Infinity };
  const cos = Math.cos(la * toRad);
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][1] * cos, ay = pts[i][0];
    const bx = pts[i + 1][1] * cos, by = pts[i + 1][0];
    const px = lo * cos, py = la;
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const d = distM(la, lo, ay + t * dy, (ax + t * dx) / cos);
    if (d < best.dist) best = { seg: i, frac: t, dist: d };
  }
  return best;
}

/** Slice a polyline between the points closest to a and b (in order). */
export function slicePolyline(pts: LatLon[], a: LatLon, b: LatLon): LatLon[] {
  if (pts.length < 2) return [a, b];
  const pa = projectOnLine(pts, a[0], a[1]);
  // search b only after a
  const rest = pts.slice(pa.seg);
  const pb = projectOnLine(rest, b[0], b[1]);
  const endSeg = pa.seg + pb.seg;
  if (pa.dist > 400 || pb.dist > 400 || endSeg < pa.seg) return [a, b];
  const out: LatLon[] = [a];
  for (let i = pa.seg + 1; i <= endSeg; i++) out.push(pts[i]);
  out.push(b);
  return out;
}
