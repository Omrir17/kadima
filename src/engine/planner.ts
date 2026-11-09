import { Day, Loader, Net, loadDay, loadShapeBucket, patLen, patStop, tripTime, WALK_FACTOR } from './data';
import { decodePolyline, distM, LatLon, projectOnLine, slicePolyline } from './geo';
import { Access, Egress, Raptor, RawLeg, RoundResult } from './raptor';
import {
  BusCandidate, Departure, Itinerary, Leg, LineVariant, Place, PlanRequest, PlanResponse, Prefs, StopRef, VehicleView,
} from './model';
import { addDays, daySecToEpoch, epochToDaySec, israelParts, trafficFactor } from './time';
import { trafficRoute } from '../services/tomtom';
import { estDriveSec, footRoute, osrmOneToMany, osrmRoute } from '../services/osrm';
import { Vehicle, vehiclesForRoute, vehiclesForRoutes } from '../services/live';
import { lineColor } from './operators';

type AccInfo =
  | { kind: 'walk'; from: Place; dist: number; dur: number }
  | { kind: 'car'; role: 'dropoff'; from: Place; driveSec: number; approx: boolean }
  | { kind: 'ride'; dropAt: Place; carSec: number; walkDist: number; walkDur: number; detourSec: number; routeI: number; p: LatLon; detourTo?: LatLon }
  | { kind: 'onbus'; pos: number };

type EgInfo =
  | { kind: 'walk'; to: Place; dist: number; dur: number }
  | { kind: 'car'; role: 'pickup'; to: Place; driveToSec: number; driveFromDriverSec: number; driver: Place; approx: boolean };

interface Ctx {
  day: Day;
  raptor: Raptor;
  acc: Access[];
  accInfo: AccInfo[];
  eg: Egress[];
  egInfo: EgInfo[];
  prefs: Prefs;
  t0: number;
  bus?: { pattern: number; trip: number; nextPos: number; delay: number; here: Place };
  rideCoords?: LatLon[];
  delays?: Map<number, number>; // live delays by trip index
  banned?: Uint8Array; // patterns excluded by the user's mode preferences
}

interface PatGeom { pts: LatLon[]; cum: number[]; stopD: number[] }

const HANDOVER = 60; // seconds to get in/out of a car

export class Planner {
  private days = new Map<string, Promise<{ day: Day; raptor: Raptor }>>();
  private fieldCache = new Map<string, { at: number; v: Promise<Map<number, number>> }>();
  private bannedCache = new Map<string, Uint8Array | undefined>();
  private geomCache = new Map<string, Promise<PatGeom>>();

  constructor(public net: Net, private load: Loader) {}

  // ---------------------------------------------------------------- basics

  getDay(date: string) {
    let p = this.days.get(date);
    if (!p) {
      if (!this.net.days.includes(date)) throw new Error('אין נתוני לוחות זמנים לתאריך הזה');
      p = loadDay(this.load, this.net, date).then((day) => ({ day, raptor: new Raptor(this.net, day) }));
      this.days.set(date, p);
      p.catch(() => this.days.delete(date));
      // keep memory bounded
      if (this.days.size > 3) {
        const first = this.days.keys().next().value as string;
        if (first !== date) this.days.delete(first);
      }
    }
    return p;
  }

  stopPlace(s: number): Place {
    const st = this.net.stops;
    return { lat: st.lat[s], lon: st.lon[s], name: st.name[s], stop: s, code: st.code[s], sub: st.city[s] };
  }

  private walkAccess(pt: Place, prefs: Prefs, limit = 60) {
    const crow = prefs.maxWalk / WALK_FACTOR;
    const list = this.net.grid.near(pt.lat, pt.lon, crow, limit);
    if (pt.stop !== undefined && !list.some(([s]) => s === pt.stop)) list.unshift([pt.stop, 0]);
    return list.map(([s, d]) => {
      const dist = Math.round(d * WALK_FACTOR);
      return { stop: s, dist, dur: Math.round(dist / prefs.walkSpeed) };
    });
  }

  private when(req: PlanRequest) {
    const ms = req.time ?? Date.now();
    const p = israelParts(ms);
    return { ms, date: p.ymd, sec: p.sec };
  }

  private baseCtx(day: Day, raptor: Raptor, prefs: Prefs, t0: number): Ctx {
    return { day, raptor, acc: [], accInfo: [], eg: [], egInfo: [], prefs, t0, banned: this.bannedFor(day, prefs) };
  }

  /** Patterns the user excluded (no buses / no trains / no light rail). */
  private bannedFor(day: Day, prefs: Prefs): Uint8Array | undefined {
    if (!prefs.noBus && !prefs.noTrain && !prefs.noLightRail) return undefined;
    const key = `${day.date}:${+!!prefs.noBus}${+!!prefs.noTrain}${+!!prefs.noLightRail}`;
    if (this.bannedCache.has(key)) return this.bannedCache.get(key);
    const b = new Uint8Array(day.nPat);
    for (let p = 0; p < day.nPat; p++) {
      const t = this.net.routes[day.patRoute[p]][5];
      if ((prefs.noBus && (t === 3 || t === 715)) || (prefs.noTrain && t === 2) || (prefs.noLightRail && (t === 0 || t === 5 || t === 8))) b[p] = 1;
    }
    this.bannedCache.set(key, b);
    return b;
  }

  private addWalkAccess(ctx: Ctx, from: Place, time: number) {
    for (const w of this.walkAccess(from, ctx.prefs)) {
      ctx.accInfo.push({ kind: 'walk', from, dist: w.dist, dur: w.dur });
      ctx.acc.push({ stop: w.stop, time: time + w.dur, tag: ctx.accInfo.length - 1 });
    }
  }

  private addWalkEgress(ctx: Ctx, to: Place) {
    for (const w of this.walkAccess(to, ctx.prefs)) {
      ctx.egInfo.push({ kind: 'walk', to, dist: w.dist, dur: w.dur });
      ctx.eg.push({ stop: w.stop, dur: w.dur, pen: Math.round(w.dur * 0.3), tag: ctx.egInfo.length - 1 });
    }
  }

  private run(ctx: Ctx, maxTime?: number): RoundResult[] {
    return ctx.raptor.run(ctx.acc, ctx.eg, {
      maxRounds: ctx.prefs.maxRounds,
      slack: ctx.prefs.slack,
      walkSpeed: ctx.prefs.walkSpeed,
      maxTime: maxTime ?? ctx.t0 + 5 * 3600,
      delays: ctx.delays,
      banned: ctx.banned,
    });
  }

  // ---------------------------------------------------------------- itinerary assembly

  private transitLeg(day: Day, l: Extract<RawLeg, { t: 'transit' }>, delay?: number): Leg {
    const net = this.net;
    const r = net.routes[day.patRoute[l.pat]];
    const stops: StopRef[] = [];
    for (let i = l.board; i <= l.alight; i++) {
      const s = patStop(day, l.pat, i);
      stops.push({ stop: s, name: net.stops.name[s], lat: net.stops.lat[s], lon: net.stops.lon[s], code: net.stops.code[s], t: tripTime(day, l.trip, i) + (delay ?? 0) });
    }
    return {
      kind: 'transit',
      from: this.stopPlace(stops[0].stop),
      to: this.stopPlace(stops[stops.length - 1].stop),
      dep: l.dep,
      arr: l.arr,
      route: day.patRoute[l.pat],
      gtfsRoute: r[0],
      line: r[1] || (r[5] === 2 ? 'רכבת' : ''),
      agency: r[4],
      agencyName: net.agencies[r[4]] || '',
      rtype: r[5],
      color: lineColor(r[4], r[5], r[6]),
      headsign: net.headsigns[day.patHead[l.pat]] || r[3],
      pattern: l.pat,
      trip: l.trip,
      tripRef: day.tripRef[l.trip],
      board: l.board,
      alight: l.alight,
      stops,
      shape: day.patShape[l.pat],
      ...(delay !== undefined ? { live: true, delay } : {}),
    };
  }

  private build(ctx: Ctx, res: RoundResult): Itinerary {
    const { day } = ctx;
    const legs: Leg[] = [];
    let accessLeg: RawLeg | null = null;
    for (const l of res.legs) {
      if (l.t === 'access') accessLeg = l;
      else if (l.t === 'transit') legs.push(this.transitLeg(day, l, ctx.delays?.get(l.trip)));
      else legs.push({ kind: 'walk', from: this.stopPlace(l.from), to: this.stopPlace(l.to), dep: l.dep, arr: l.arr, dist: l.dist });
    }
    const firstTransit = legs.find((l) => l.kind === 'transit');
    const pre: Leg[] = [];
    if (accessLeg && accessLeg.t === 'access') {
      const info = ctx.accInfo[accessLeg.tag];
      const stopP = this.stopPlace(accessLeg.stop);
      // time we need to be at the access stop
      const needAt = firstTransit ? firstTransit.dep - 60 : accessLeg.time;
      if (info.kind === 'walk') {
        if (info.dist > 0) {
          const arr = Math.max(accessLeg.time, needAt);
          pre.push({ kind: 'walk', from: info.from, to: stopP, dep: arr - info.dur, arr, dist: info.dist });
        }
      } else if (info.kind === 'car') {
        const arr = Math.max(accessLeg.time, firstTransit ? firstTransit.dep - 180 : accessLeg.time);
        pre.push({
          kind: 'car', from: info.from, to: stopP, dep: arr - info.driveSec, arr,
          car: { role: 'dropoff', driveSec: info.driveSec, driverLeaves: arr - info.driveSec - HANDOVER, driverTotalSec: info.driveSec * 2, driverFrom: info.from, approx: info.approx },
        });
      } else if (info.kind === 'ride') {
        const carArr = ctx.t0 + info.carSec;
        const rc = ctx.rideCoords!;
        const geometry = rc.slice(0, info.routeI + 1).concat([info.p]);
        if (info.detourTo) geometry.push(info.detourTo);
        pre.push({
          kind: 'car', from: { lat: rc[0][0], lon: rc[0][1], name: 'המיקום שלי' }, to: info.dropAt,
          dep: ctx.t0, arr: carArr, geometry,
          car: { role: 'ride', driveSec: info.carSec, detourSec: info.detourSec, approx: true },
        });
        if (info.walkDist > 20) {
          pre.push({ kind: 'walk', from: info.dropAt, to: stopP, dep: carArr + HANDOVER, arr: carArr + HANDOVER + info.walkDur, dist: info.walkDist });
        }
      } else if (info.kind === 'onbus' && ctx.bus) {
        const b = ctx.bus;
        const raw = { t: 'transit' as const, trip: b.trip, pat: b.pattern, board: b.nextPos, alight: info.pos, dep: ctx.t0, arr: tripTime(day, b.trip, info.pos) + b.delay };
        const leg = this.transitLeg(day, raw);
        leg.onBus = true;
        leg.delay = b.delay;
        leg.from = b.here;
        leg.dep = ctx.t0;
        leg.arr = raw.arr;
        leg.stops = leg.stops!.map((s) => ({ ...s, t: s.t + b.delay }));
        pre.push(leg);
      }
    }
    const post: Leg[] = [];
    const lastStop = legs.length ? legs[legs.length - 1].to : accessLeg ? this.stopPlace((accessLeg as any).stop) : null;
    const tEnd = legs.length ? legs[legs.length - 1].arr : (accessLeg as any)?.time ?? ctx.t0;
    const eInfo = ctx.egInfo[res.egress];
    if (eInfo && lastStop) {
      if (eInfo.kind === 'walk') {
        if (eInfo.dist > 0) post.push({ kind: 'walk', from: lastStop, to: eInfo.to, dep: tEnd, arr: tEnd + eInfo.dur, dist: eInfo.dist });
      } else {
        const pickAt = tEnd + HANDOVER;
        post.push({
          kind: 'car', from: lastStop, to: eInfo.to, dep: pickAt, arr: pickAt + eInfo.driveToSec,
          car: {
            role: 'pickup', driveSec: eInfo.driveToSec, driverLeaves: tEnd - eInfo.driveFromDriverSec,
            driverTotalSec: eInfo.driveFromDriverSec + eInfo.driveToSec, driverFrom: eInfo.driver, approx: eInfo.approx,
          },
        });
      }
    }
    return this.finalize(mergeWalks([...pre, ...legs, ...post], ctx.prefs), day.date, res.cost);
  }

  private finalize(legs: Leg[], date: string, cost: number): Itinerary {
    const transitN = legs.filter((l) => l.kind === 'transit').length;
    const sig = legs.map((l) => (l.kind === 'transit' ? `${l.tripRef}:${l.board}-${l.alight}` : l.kind + ':' + (l.to.stop ?? l.to.name))).join('|');
    return {
      id: sig,
      date,
      legs,
      dep: legs.length ? legs[0].dep : 0,
      arr: legs.length ? legs[legs.length - 1].arr : 0,
      transfers: Math.max(0, transitN - 1),
      walkM: legs.filter((l) => l.kind === 'walk').reduce((a, l) => a + (l.dist || 0), 0),
      cost,
      tags: [],
    };
  }

  private pareto(list: Itinerary[], max = 5): Itinerary[] {
    const uniq = new Map<string, Itinerary>();
    for (const it of list) if (!uniq.has(it.id)) uniq.set(it.id, it);
    let arr = [...uniq.values()];
    arr = arr.filter((a) => !arr.some((b) => b !== a &&
      b.arr <= a.arr && b.dep >= a.dep && b.transfers <= a.transfers && b.walkM <= a.walkM + 100 &&
      (b.arr < a.arr || b.dep > a.dep || b.transfers < a.transfers)));
    arr.sort((a, b) => a.cost - b.cost || a.arr - b.arr);
    arr = arr.slice(0, max);
    if (arr.length) {
      const fastest = arr.reduce((a, b) => (b.arr < a.arr ? b : a));
      fastest.tags.push('הכי מהיר');
      const fewest = arr.reduce((a, b) => (b.transfers < a.transfers || (b.transfers === a.transfers && b.arr < a.arr) ? b : a));
      if (fewest !== fastest && fewest.transfers < fastest.transfers) fewest.tags.push('פחות החלפות');
      const leastWalk = arr.reduce((a, b) => (b.walkM < a.walkM ? b : a));
      if (leastWalk !== fastest && leastWalk.walkM + 300 < fastest.walkM) leastWalk.tags.push('פחות הליכה');
    }
    arr.sort((a, b) => a.arr - b.arr || a.dep - b.dep);
    return arr;
  }

  private walkOnly(from: Place, to: Place, t0: number, prefs: Prefs, date: string): Itinerary | null {
    const d = distM(from.lat, from.lon, to.lat, to.lon) * WALK_FACTOR;
    if (d > 2500) return null;
    const dur = Math.round(d / prefs.walkSpeed);
    const it = this.finalize([{ kind: 'walk', from, to, dep: t0, arr: t0 + dur, dist: Math.round(d) }], date, dur);
    it.tags.push('ברגל');
    return it;
  }

  // ---------------------------------------------------------------- mode: plain transit

  async planTransit(req: PlanRequest): Promise<PlanResponse> {
    const { date, sec } = this.when(req);
    const { day, raptor } = await this.getDay(date);
    const from = req.from!;
    const to = req.to;
    let t = sec;
    if (req.arriveBy) {
      const latest = await this.latestDeparture(day, raptor, req, sec);
      if (latest === null) return { date, itineraries: [], note: 'לא נמצא מסלול שמגיע בזמן' };
      t = latest;
    }
    // real-time: learn how late the buses around me are, then plan with real times
    let delays: Map<number, number> | undefined;
    if (req.live && !req.arriveBy) {
      try {
        const quick = this.transitRuns(day, raptor, req, t, undefined, 2);
        delays = await this.liveDelaysAround(day, date, from, t, req.prefs, quick);
      } catch { /* plan without live data */ }
    }
    let its = this.transitRuns(day, raptor, req, t, delays, 5);
    if (req.arriveBy) its = its.filter((x) => x.arr <= sec + 60);
    // late at night: also show tomorrow's first departures
    const next = addDays(date, 1);
    if (!req.arriveBy && t > 20 * 3600 && its.length < 4 && this.net.days.includes(next)) {
      try {
        const nd = await this.getDay(next);
        // the next day's file also holds tonight's trips that run past midnight: skip those we already have
        const have = new Set(its.map((x) => x.id));
        const more = this.transitRuns(nd.day, nd.raptor, req, t - 86400, undefined, 3).filter((m) => !have.has(m.id));
        for (const m of more) m.tags = m.tags.filter((x) => x !== 'הכי מהיר').concat(m.dep >= 0 ? ['אחרי חצות'] : []);
        its = its.concat(more.slice(0, 4 - its.length));
      } catch { /* no data for tomorrow */ }
    }
    const today = its.filter((x) => x.date === date);
    const walk = this.walkOnly(from, to, t, req.prefs, date);
    if (walk && (today.length === 0 || walk.arr <= Math.min(...today.map((x) => x.arr)) + 10 * 60)) its.push(walk);
    let note: string | undefined;
    if (!its.length) note = israelParts(req.time ?? Date.now()).weekday === 6 ? 'אין תחבורה ציבורית בשבת בשעות האלו' : 'לא נמצא מסלול';
    return { date, itineraries: its, note, live: !!delays && delays.size > 0 };
  }

  /**
   * Several RAPTOR runs at successive departure times ("range" search) so the user gets
   * real alternatives (later buses, fewer transfers, less walking), then a Pareto filter.
   */
  private transitRuns(day: Day, raptor: Raptor, req: PlanRequest, t: number, delays: Map<number, number> | undefined, runs: number): Itinerary[] {
    const results: Itinerary[] = [];
    let runAt = t;
    for (let i = 0; i < runs; i++) {
      const ctx = this.baseCtx(day, raptor, req.prefs, runAt);
      ctx.delays = delays;
      this.addWalkAccess(ctx, req.from!, runAt);
      this.addWalkEgress(ctx, req.to);
      const rs = this.run(ctx);
      if (!rs.length) break;
      const its = rs.map((r) => this.build(ctx, r));
      results.push(...its);
      // next run: just after the earliest departure we found, so the next bus shows up
      const leaves = its.filter((it) => it.legs.some((l) => l.kind === 'transit')).map((it) => it.dep);
      if (!leaves.length) break;
      runAt = Math.max(runAt + 60, Math.min(...leaves) + 60);
      if (req.arriveBy) break;
    }
    return this.pareto(results, 6);
  }

  /**
   * Fetches live positions for the lines I could take soon (and the lines of a quick plan)
   * and turns them into per-trip delays for the router.
   */
  private async liveDelaysAround(day: Day, date: string, from: Place, t: number, prefs: Prefs, quick: Itinerary[]) {
    const routeFirst = new Map<number, number>(); // route -> earliest departure near me
    for (const w of this.walkAccess(from, prefs, 40)) {
      for (let j = day.spOff[w.stop]; j < day.spOff[w.stop + 1]; j++) {
        const p = day.spPat[j], pos = day.spPos[j];
        const t0 = day.patTripOff[p], t1 = day.patTripOff[p + 1];
        let lo = t0, hi = t1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (tripTime(day, mid, pos) >= t - 15 * 60) hi = mid; else lo = mid + 1;
        }
        if (lo >= t1) continue;
        const dep = tripTime(day, lo, pos);
        if (dep > t + 45 * 60) continue;
        const r = day.patRoute[p];
        if (!routeFirst.has(r) || dep < routeFirst.get(r)!) routeFirst.set(r, dep);
      }
    }
    const routes = new Set<number>([...routeFirst].sort((a, b) => a[1] - b[1]).slice(0, 14).map(([r]) => r));
    for (const it of quick) for (const l of it.legs) if (l.route !== undefined) routes.add(l.route);
    const ids = [...routes].slice(0, 22).map((r) => this.net.routes[r][0]);
    const vs = await vehiclesForRoutes(ids);
    const delays = new Map<number, number>();
    for (const v of vs) {
      const trip = day.tripByRef.get(v.tripRef);
      if (trip === undefined) continue;
      const est = this.vehicleProgress(day, trip, v, date);
      if (est) delays.set(trip, Math.max(-10 * 60, Math.min(40 * 60, est.delay)));
    }
    return delays;
  }

  private async latestDeparture(day: Day, raptor: Raptor, req: PlanRequest, arriveBy: number) {
    const arrivalFor = (t: number) => {
      const ctx = this.baseCtx(day, raptor, req.prefs, t);
      this.addWalkAccess(ctx, req.from!, t);
      this.addWalkEgress(ctx, req.to);
      const rs = this.run(ctx, arriveBy + 1);
      return rs.length ? Math.min(...rs.map((r) => r.arr)) : Infinity;
    };
    let lo = arriveBy - 4 * 3600, hi = arriveBy;
    if (arrivalFor(lo) > arriveBy) return null;
    while (hi - lo > 60) {
      const mid = Math.floor((lo + hi) / 2);
      if (arrivalFor(mid) <= arriveBy) lo = mid; else hi = mid;
    }
    return lo;
  }

  // ---------------------------------------------------------------- drive-time field

  /**
   * Free-flow driving seconds between `center` and every stop within reach.
   * Uses OSRM for one representative stop per ~600m cell to keep requests low.
   */
  async driveField(center: LatLon, maxFreeSec: number, dir: 'out' | 'in'): Promise<{ times: Map<number, number>; approx: boolean }> {
    const key = `${dir}:${center[0].toFixed(4)},${center[1].toFixed(4)}:${Math.round(maxFreeSec / 60)}`;
    const cached = this.fieldCache.get(key);
    let approx = false;
    if (cached && Date.now() - cached.at < 6 * 3600e3) return { times: await cached.v, approx };
    // radius where estimate exceeds limit
    let R = 500;
    while (R < 60000 && estDriveSec(R) < maxFreeSec * 1.3) R += 250;
    const cand = this.net.grid.near(center[0], center[1], R);
    const cells = new Map<string, number[]>();
    for (const [s] of cand) {
      const la = this.net.lat[s], lo = this.net.lon[s];
      const k = Math.floor(la / 0.0055) + ':' + Math.floor(lo / 0.0065);
      let c = cells.get(k);
      if (!c) cells.set(k, (c = []));
      c.push(s);
    }
    const reps: number[] = [];
    for (const list of cells.values()) {
      let mla = 0, mlo = 0;
      for (const s of list) { mla += this.net.lat[s]; mlo += this.net.lon[s]; }
      mla /= list.length; mlo /= list.length;
      let best = list[0], bd = Infinity;
      for (const s of list) {
        const d = distM(mla, mlo, this.net.lat[s], this.net.lon[s]);
        if (d < bd) { bd = d; best = s; }
      }
      reps.push(best);
    }
    const compute = (async () => {
      let repTimes: number[];
      try {
        repTimes = await osrmOneToMany(center, reps.map((s) => [this.net.lat[s], this.net.lon[s]] as LatLon), dir);
      } catch {
        approx = true;
        repTimes = reps.map(() => NaN);
      }
      const repOf = new Map<string, number>();
      let i = 0;
      for (const k of cells.keys()) repOf.set(k, i++);
      const times = new Map<number, number>();
      for (const [s, d] of cand) {
        const la = this.net.lat[s], lo = this.net.lon[s];
        const k = Math.floor(la / 0.0055) + ':' + Math.floor(lo / 0.0065);
        const ri = repOf.get(k)!;
        const rs = reps[ri];
        let t = repTimes[ri];
        if (isNaN(t)) t = estDriveSec(d);
        else t += (distM(la, lo, this.net.lat[rs], this.net.lon[rs]) * 1.4) / 6;
        if (t <= maxFreeSec) times.set(s, Math.round(t));
      }
      return times;
    })();
    this.fieldCache.set(key, { at: Date.now(), v: compute });
    compute.catch(() => this.fieldCache.delete(key));
    const times = await compute;
    return { times, approx };
  }

  // ---------------------------------------------------------------- mode: someone picks me up at the end

  async planPickup(req: PlanRequest): Promise<PlanResponse> {
    const { ms, date, sec } = this.when(req);
    const { day, raptor } = await this.getDay(date);
    const from = req.from!;
    const driver = req.driver!;
    const to = req.to;
    const maxSec = (req.maxDriveMin ?? 10) * 60;
    const lambda = req.lambda ?? 0.3;
    const sameDest = distM(driver.lat, driver.lon, to.lat, to.lon) < 150;
    // traffic around the expected pickup time (~ 45 min after now)
    const factor = trafficFactor(ms + 45 * 60e3);
    const field = await this.driveField([driver.lat, driver.lon], maxSec / factor, 'out');
    let toField = field;
    if (!sameDest) toField = await this.driveField([to.lat, to.lon], (maxSec * 3) / factor, 'in');
    const ctx = this.baseCtx(day, raptor, req.prefs, sec);
    this.addWalkAccess(ctx, from, sec);
    // walking all the way is still allowed
    this.addWalkEgress(ctx, to);
    for (const [s, free] of field.times) {
      const out = Math.round(free * factor);
      if (out > maxSec) continue;
      const back = toField.times.get(s);
      const toSec = Math.round((back ?? free) * factor);
      if (sameDest && toSec > maxSec * 1.3) continue;
      ctx.egInfo.push({ kind: 'car', role: 'pickup', to, driveToSec: toSec, driveFromDriverSec: out, driver, approx: field.approx });
      ctx.eg.push({ stop: s, dur: HANDOVER + toSec, pen: Math.round(lambda * (out + toSec)), tag: ctx.egInfo.length - 1 });
    }
    const results: Itinerary[] = this.run(ctx).map((r) => this.build(ctx, r));
    // Second pass with a stricter driving limit -> "less driving" alternative
    const ctx2 = { ...ctx, eg: ctx.eg.filter((e) => { const i = ctx.egInfo[e.tag]; return i.kind === 'walk' || i.driveFromDriverSec <= maxSec * 0.55; }) };
    results.push(...this.run(ctx2).map((r) => this.build(ctx2, r)));
    // car-only pass: guarantees a plan that actually uses the driver, even when the bus reaches the door
    const ctx3 = { ...ctx, eg: ctx.eg.filter((e) => ctx.egInfo[e.tag].kind === 'car') };
    results.push(...this.run(ctx3).map((r) => this.build(ctx3, r)));
    // the driver could also come all the way to me
    const direct = await this.directCar(from, driver, to, sec, maxSec, factor, 'pickup', date, lambda);
    if (direct) results.push(direct);
    let its = this.rankFlexible(results, 5);
    const traffic = await this.applyTraffic(its, req, sec, date, maxSec, lambda);
    its = this.retag(its, 4, (it) => it.arr + lambda * carSec(it));
    const baseline = await this.baseline(req, from, to);
    return { date, itineraries: its, baseline, approx: field.approx && traffic !== 'on', traffic };
  }

  private async directCar(from: Place, driver: Place, to: Place, t0: number, maxSec: number, factor: number, role: 'pickup' | 'dropoff', date: string, lambda: number): Promise<Itinerary | null> {
    try {
      const d1 = await osrmOneToMany([driver.lat, driver.lon], [[from.lat, from.lon]], 'out');
      const a = Math.round((d1[0] || estDriveSec(distM(driver.lat, driver.lon, from.lat, from.lon))) * factor);
      if (a > maxSec) return null;
      const d2 = await osrmOneToMany([from.lat, from.lon], [[to.lat, to.lon]], 'out');
      const b = Math.round((d2[0] || estDriveSec(distM(from.lat, from.lon, to.lat, to.lon))) * factor);
      if (b > maxSec * 1.3) return null;
      const dep = role === 'pickup' ? t0 + a : t0;
      const leg: Leg = {
        kind: 'car', from, to, dep, arr: dep + b,
        car: { role, driveSec: b, driverLeaves: role === 'pickup' ? t0 : t0, driverTotalSec: a + b, driverFrom: driver },
      };
      const it = this.finalize([leg], date, dep + b + lambda * (a + b));
      it.tags.push('נסיעה עד הסוף');
      return it;
    } catch {
      return null;
    }
  }

  private rankFlexible(list: Itinerary[], max: number) {
    const uniq = new Map<string, Itinerary>();
    for (const it of list) {
      const prev = uniq.get(it.id);
      if (!prev || it.cost < prev.cost) uniq.set(it.id, it);
    }
    const arr = [...uniq.values()].sort((a, b) => a.cost - b.cost);
    const out: Itinerary[] = [];
    for (const it of arr) {
      if (out.some((o) => o.arr <= it.arr && o.transfers <= it.transfers && carSec(o) <= carSec(it))) continue;
      out.push(it);
      if (out.length >= max) break;
    }
    // always show the best plan that actually uses the car, even when plain transit wins
    if (!out.some(hasCar)) {
      const bestCar = arr.find(hasCar);
      if (bestCar) out.push(bestCar);
    }
    for (const o of out) if (!hasCar(o) && !o.tags.includes('ברגל')) o.tags.push('בלי רכב');
    if (out.length) {
      out[0].tags.push('מומלץ');
      const fastest = out.reduce((a, b) => (b.arr < a.arr ? b : a));
      if (fastest !== out[0]) fastest.tags.push('הכי מהיר');
      const leastDrive = out.reduce((a, b) => (carSec(b) < carSec(a) ? b : a));
      if (leastDrive !== out[0] && leastDrive !== fastest) leastDrive.tags.push('פחות נהיגה');
    }
    return out;
  }

  private async baseline(req: PlanRequest, from: Place, to: Place) {
    try {
      const r = await this.planTransit({ ...req, mode: 'transit', from, to, arriveBy: false });
      const pure = r.itineraries.filter((i) => i.legs.some((l) => l.kind === 'transit') || i.tags.includes('ברגל'));
      return pure.length ? pure.reduce((a, b) => (b.arr < a.arr ? b : a)) : null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- mode: someone drops me at a station first

  async planDropoff(req: PlanRequest): Promise<PlanResponse> {
    const { ms, date, sec } = this.when(req);
    const { day, raptor } = await this.getDay(date);
    const driver = req.driver ?? req.from!;
    const to = req.to;
    const maxSec = (req.maxDriveMin ?? 10) * 60;
    const lambda = req.lambda ?? 0.3;
    const factor = trafficFactor(ms);
    const field = await this.driveField([driver.lat, driver.lon], maxSec / factor, 'out');
    const results: Itinerary[] = [];
    for (const frac of [1, 0.6, 0.3]) {
      const ctx = this.baseCtx(day, raptor, req.prefs, sec);
      // walking from the driver's place is always an option too
      this.addWalkAccess(ctx, driver, sec);
      for (const [s, free] of field.times) {
        const d = Math.round(free * factor);
        if (d > maxSec * frac) continue;
        ctx.accInfo.push({ kind: 'car', role: 'dropoff', from: driver, driveSec: d, approx: field.approx });
        ctx.acc.push({ stop: s, time: sec + HANDOVER + d, tag: ctx.accInfo.length - 1 });
      }
      this.addWalkEgress(ctx, to);
      // first pass also runs car-only, so a drop-off plan always exists to compare
      const passes = frac === 1 ? [ctx, { ...ctx, acc: ctx.acc.filter((x) => ctx.accInfo[x.tag].kind === 'car') }] : [ctx];
      for (const c of passes) {
        for (const r of this.run(c)) {
          const it = this.build(c, r);
          it.cost = it.arr - sec + lambda * carSec(it) * 2;
          results.push(it);
        }
      }
    }
    const direct = await this.directCar(driver, driver, to, sec, maxSec, factor, 'dropoff', date, lambda);
    if (direct) { direct.cost = direct.arr - sec + lambda * carSec(direct) * 2; results.push(direct); }
    let its = this.rankFlexible(results, 5);
    const traffic = await this.applyTraffic(its, req, sec, date, maxSec, lambda);
    its = this.retag(its, 4, (it) => it.arr + lambda * carSec(it));
    const baseline = await this.baseline(req, driver, to);
    return { date, itineraries: its, baseline, approx: field.approx && traffic !== 'on', traffic };
  }

  // ---------------------------------------------------------------- mode: I'm riding with someone

  async planRide(req: PlanRequest): Promise<PlanResponse> {
    const { ms, date, sec } = this.when(req);
    const { day, raptor } = await this.getDay(date);
    const from = req.from!;
    const rideDest = req.rideDest!;
    const to = req.to;
    const detour = (req.detourMin ?? 0) * 60;
    let route;
    let approx = false;
    try {
      route = await osrmRoute([[from.lat, from.lon], [rideDest.lat, rideDest.lon]]);
    } catch {
      approx = true;
      const dur = estDriveSec(distM(from.lat, from.lon, rideDest.lat, rideDest.lon));
      route = { dur, dist: 0, coords: [[from.lat, from.lon], [rideDest.lat, rideDest.lon]] as LatLon[], cum: [0, dur] };
    }
    const factor = req.wazeMin ? (req.wazeMin * 60) / Math.max(60, route.dur) : trafficFactor(ms);
    // densify the polyline to ~80m steps with cumulative times
    const pts: { p: LatLon; t: number; i: number }[] = [];
    for (let i = 0; i < route.coords.length; i++) {
      const a = route.coords[i];
      pts.push({ p: a, t: route.cum[i] * factor, i });
      if (i + 1 < route.coords.length) {
        const b = route.coords[i + 1];
        const d = distM(a[0], a[1], b[0], b[1]);
        const steps = Math.floor(d / 80);
        for (let k = 1; k <= steps; k++) {
          const f = k / (steps + 1);
          pts.push({ p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], t: (route.cum[i] + (route.cum[i + 1] - route.cum[i]) * f) * factor, i });
        }
      }
    }
    const ctx = this.baseCtx(day, raptor, req.prefs, sec);
    ctx.rideCoords = route.coords;
    const bestByStop = new Map<number, { time: number; info: AccInfo }>();
    const walkR = 450 / WALK_FACTOR;
    const detourR = detour > 0 ? Math.min(6000, detour * 4) : 0;
    for (let k = 0; k < pts.length; k++) {
      const { p, t, i } = pts[k];
      for (const [s, d] of this.net.grid.near(p[0], p[1], Math.max(walkR, detourR))) {
        let time: number, info: AccInfo;
        const stopP = this.stopPlace(s);
        if (d <= walkR) {
          const wd = Math.round(d * WALK_FACTOR);
          const wt = Math.round(wd / req.prefs.walkSpeed);
          time = sec + t + HANDOVER + wt;
          info = { kind: 'ride', dropAt: { lat: p[0], lon: p[1], name: 'ליד ' + stopP.name }, carSec: Math.round(t), walkDist: wd, walkDur: wt, detourSec: 0, routeI: i, p };
          if (d < 40) info.dropAt = stopP;
        } else {
          const extra = estDriveSec(d) * factor;
          if (2 * extra > detour) continue;
          time = sec + t + extra + HANDOVER;
          info = { kind: 'ride', dropAt: stopP, carSec: Math.round(t + extra), walkDist: 0, walkDur: 0, detourSec: Math.round(2 * extra), routeI: i, p, detourTo: [stopP.lat, stopP.lon] };
        }
        const prev = bestByStop.get(s);
        // prefer earlier arrival at stop, small penalty for detours
        const score = time + (info.kind === 'ride' ? info.detourSec * 0.5 : 0);
        const prevScore = prev ? prev.time + (prev.info.kind === 'ride' ? prev.info.detourSec * 0.5 : 0) : Infinity;
        if (score < prevScore) bestByStop.set(s, { time, info });
      }
    }
    for (const [s, v] of bestByStop) {
      ctx.accInfo.push(v.info);
      ctx.acc.push({ stop: s, time: Math.round(v.time), tag: ctx.accInfo.length - 1 });
    }
    this.addWalkEgress(ctx, to);
    const results = this.run(ctx).map((r) => this.build(ctx, r));
    // could the driver drop me close enough to walk, or take me there directly?
    let bestDirect: Itinerary | null = null;
    for (const { p, t, i } of pts) {
      const d = distM(p[0], p[1], to.lat, to.lon);
      const coordsSoFar = () => route.coords.slice(0, i + 1).concat([p]);
      let it: Itinerary | null = null;
      if (d * WALK_FACTOR <= 1500) {
        const wd = Math.round(d * WALK_FACTOR);
        const wt = wd / req.prefs.walkSpeed;
        const dropAt: Place = { lat: p[0], lon: p[1], name: 'נקודת ירידה' };
        it = this.finalize([
          { kind: 'car', from, to: dropAt, dep: sec, arr: sec + t, geometry: coordsSoFar(), car: { role: 'ride', driveSec: Math.round(t), detourSec: 0, approx: true } },
          { kind: 'walk', from: dropAt, to, dep: sec + t + HANDOVER, arr: sec + t + HANDOVER + wt, dist: wd },
        ], date, sec + t + HANDOVER + wt);
      }
      if (detour > 0) {
        const extra = estDriveSec(d) * factor;
        if (2 * extra <= detour) {
          const cand = this.finalize([
            { kind: 'car', from, to, dep: sec, arr: sec + t + extra, geometry: [...coordsSoFar(), [to.lat, to.lon]], car: { role: 'ride', driveSec: Math.round(t + extra), detourSec: Math.round(2 * extra), approx: true } },
          ], date, sec + t + extra + extra);
          if (!it || cand.cost < it.cost) it = cand;
        }
      }
      if (it && (!bestDirect || it.cost < bestDirect.cost)) bestDirect = it;
    }
    if (bestDirect) { bestDirect.tags.push('בלי תחבורה ציבורית'); results.push(bestDirect); }
    for (const it of results) it.cost = it.arr + (it.legs[0]?.car?.detourSec ?? 0) * 0.5;
    let its = this.rankFlexible(results, 5);
    // an explicit Waze time from the user wins over our traffic lookup
    const traffic = req.wazeMin ? 'off' : await this.applyTraffic(its, req, sec, date, 0, 0);
    its = this.retag(its, 4, (it) => it.arr + (it.legs[0]?.car?.detourSec ?? 0) * 0.5);
    const note = req.wazeMin || traffic === 'on' ? undefined : 'זמני הנסיעה מוערכים. אפשר לכייל לפי Waze, או להוסיף מפתח TomTom בהגדרות.';
    return { date, itineraries: its, approx: approx && traffic !== 'on', note, traffic };
  }

  // ---------------------------------------------------------------- traffic (TomTom)

  /**
   * Re-times the car legs of the shown itineraries with traffic-aware TomTom routes.
   * Returns 'on' when applied, 'off' when no key, or an error message.
   */
  private async applyTraffic(its: Itinerary[], req: PlanRequest, t0: number, date: string, maxSec: number, _lambda?: number): Promise<string> {
    const key = req.trafficKey?.trim();
    if (!key) return 'off';
    const at = (sec: number) => daySecToEpoch(sec, date);
    const P = (p: Place): LatLon => [p.lat, p.lon];
    try {
      await Promise.all(its.map(async (it) => {
        for (let i = 0; i < it.legs.length; i++) {
          const leg = it.legs[i];
          const c = leg.car;
          if (!c) continue;
          if (c.role === 'pickup') {
            const driverFrom = c.driverFrom ?? leg.from;
            if (it.legs.length === 1) {
              // driver comes to me, then drives me to the destination
              const a = await trafficRoute(key, [P(driverFrom), P(leg.from)], at(t0));
              const b = await trafficRoute(key, [P(leg.from), P(leg.to)], at(t0 + a.sec));
              leg.dep = t0 + a.sec;
              leg.arr = leg.dep + b.sec;
              c.driveSec = b.sec;
              c.driverLeaves = t0;
              c.driverTotalSec = a.sec + b.sec;
              if (maxSec && a.sec > maxSec * 1.1) c.warn = `הנסיעה לנהג בפקקים: ${Math.round(a.sec / 60)} דק', יותר מהמגבלה`;
            } else {
              const meetAt = leg.dep - HANDOVER; // when I arrive at the stop
              const out = await trafficRoute(key, [P(driverFrom), P(leg.from)], at(meetAt - (c.driverTotalSec ?? 0) / 2));
              const back = await trafficRoute(key, [P(leg.from), P(leg.to)], at(leg.dep));
              c.driverLeaves = meetAt - out.sec;
              c.driveSec = back.sec;
              c.driverTotalSec = out.sec + back.sec;
              leg.arr = leg.dep + back.sec;
              if (maxSec && out.sec > maxSec * 1.1) c.warn = `בפקקים הנסיעה לנהג היא ${Math.round(out.sec / 60)} דק', יותר מהמגבלה`;
            }
          } else if (c.role === 'dropoff') {
            const r = await trafficRoute(key, [P(leg.from), P(leg.to)], at(Math.max(t0, leg.arr - c.driveSec)));
            const next = it.legs[i + 1];
            if (it.legs.length === 1) {
              leg.dep = t0;
              leg.arr = t0 + r.sec;
            } else {
              const dep = leg.arr - r.sec;
              if (dep < t0 - 60) {
                // can't leave early enough in this traffic
                leg.dep = t0;
                leg.arr = t0 + r.sec;
                c.warn = 'בגלל הפקקים יש סיכון לפספס את ההמשך';
                if (next && next.kind === 'walk') { const d = next.arr - next.dep; next.dep = leg.arr; next.arr = leg.arr + d; }
              } else leg.dep = dep;
            }
            c.driveSec = r.sec;
            c.driverLeaves = leg.dep;
            c.driverTotalSec = r.sec * 2;
            if (maxSec && r.sec > maxSec * 1.1) c.warn = c.warn ?? `בפקקים הנסיעה היא ${Math.round(r.sec / 60)} דק', יותר מהמגבלה`;
          } else if (c.role === 'ride') {
            const r = await trafficRoute(key, [P(leg.from), P(leg.to)], at(t0));
            const rideDest = req.rideDest;
            if (c.detourSec && rideDest) {
              const direct = await trafficRoute(key, [P(leg.from), P(rideDest)], at(t0));
              const via = await trafficRoute(key, [P(leg.from), P(leg.to), P(rideDest)], at(t0));
              c.detourSec = Math.max(0, via.sec - direct.sec);
            }
            leg.arr = t0 + r.sec;
            c.driveSec = r.sec;
            // shift the walk after getting out, then check the connection still works
            let tReady = leg.arr + HANDOVER;
            const next = it.legs[i + 1];
            if (next && next.kind === 'walk') {
              const d = next.arr - next.dep;
              next.dep = tReady;
              next.arr = tReady + d;
              tReady = next.arr;
            }
            const transit = it.legs.slice(i + 1).find((l) => l.kind === 'transit');
            if (transit && transit.dep < tReady) c.warn = `בפקקים עלול לפספס את קו ${transit.line} ב-${hmLocal(transit.dep)}`;
          }
          c.traffic = true;
          c.approx = false;
        }
        it.dep = it.legs[0].dep;
        it.arr = it.legs[it.legs.length - 1].arr;
      }));
      return 'on';
    } catch (e: any) {
      return String(e?.message || 'TomTom לא זמין');
    }
  }

  /** Re-sort after traffic changed times and refresh the summary tags. */
  private retag(its: Itinerary[], max: number, score: (it: Itinerary) => number) {
    const strip = new Set(['מומלץ', 'הכי מהיר', 'פחות נהיגה']);
    const warned = (it: Itinerary) => it.legs.some((l) => l.car?.warn);
    const out = [...its].sort((a, b) => Number(warned(a)) - Number(warned(b)) || score(a) - score(b)).slice(0, max);
    for (const it of out) it.tags = it.tags.filter((t) => !strip.has(t));
    if (out.length) {
      out[0].tags.push('מומלץ');
      const fastest = out.reduce((a, b) => (b.arr < a.arr ? b : a));
      if (fastest !== out[0]) fastest.tags.push('הכי מהיר');
      const leastDrive = out.reduce((a, b) => (carSec(b) < carSec(a) ? b : a));
      if (leastDrive !== out[0] && leastDrive !== fastest && carSec(leastDrive) > 0 && carSec(leastDrive) < carSec(out[0])) leastDrive.tags.push('פחות נהיגה');
    }
    return out;
  }

  // ---------------------------------------------------------------- mode: I'm already on a bus

  async findBuses(line: string, pos: LatLon | null, timeMs?: number): Promise<BusCandidate[]> {
    const { date, sec } = this.when({ time: timeMs } as PlanRequest);
    const { day } = await this.getDay(date);
    const net = this.net;
    const q = line.trim();
    const out: BusCandidate[] = [];
    for (const [ri, pats] of day.routePats) {
      const r = net.routes[ri];
      if (r[1] !== q) continue;
      for (const p of pats) {
        const n = patLen(day, p);
        const coords: LatLon[] = [];
        for (let i = 0; i < n; i++) { const s = patStop(day, p, i); coords.push([net.lat[s], net.lon[s]]); }
        let nextPos = 0, dist = 0;
        if (pos) {
          const pr = projectOnLine(coords, pos[0], pos[1]);
          if (pr.dist > 2500) continue;
          dist = pr.dist;
          nextPos = Math.min(n - 1, pr.frac > 0.05 ? pr.seg + 1 : pr.seg);
          if (nextPos === 0) nextPos = 1;
        }
        // trip closest to "now" around nextPos
        let bestT = -1, bestDiff = Infinity;
        for (let t = day.patTripOff[p]; t < day.patTripOff[p + 1]; t++) {
          if (!pos) {
            if (tripTime(day, t, 0) > sec || tripTime(day, t, n - 1) < sec) continue;
            const diff = Math.abs(tripTime(day, t, 0) - sec);
            if (diff < bestDiff) { bestDiff = diff; bestT = t; }
          } else {
            const tt = tripTime(day, t, nextPos);
            const diff = tt - sec;
            // bus should reach the next stop soon (allow being late up to 25 min, early up to 8)
            if (diff < -25 * 60 || diff > 8 * 60) continue;
            const ad = Math.abs(diff - 60);
            if (ad < bestDiff) { bestDiff = ad; bestT = t; }
          }
        }
        if (bestT < 0) continue;
        if (!pos) {
          // estimate position by schedule
          nextPos = 1;
          while (nextPos < n - 1 && tripTime(day, bestT, nextPos) < sec) nextPos++;
        }
        const s = patStop(day, p, nextPos);
        out.push({
          date, pattern: p, trip: bestT, route: ri, gtfsRoute: r[0], line: r[1], agencyName: net.agencies[r[4]] || '',
          headsign: net.headsigns[day.patHead[p]] || r[3], to: r[3], nextPos, nextStopName: net.stops.name[s], distM: Math.round(dist),
          delay: 0, live: false, schedAtNext: tripTime(day, bestT, nextPos), color: lineColor(r[4], r[5], r[6]),
        });
      }
    }
    out.sort((a, b) => a.distM - b.distM);
    // refine with live positions
    if (pos && out.length) {
      try {
        const routes = [...new Set(out.slice(0, 6).map((c) => c.gtfsRoute))];
        const vs = await vehiclesForRoutes(routes);
        for (const c of out.slice(0, 6)) {
          let best: { v: Vehicle; d: number } | null = null;
          for (const v of vs) {
            if (v.lineRef !== c.gtfsRoute) continue;
            const d = distM(pos[0], pos[1], v.lat, v.lon);
            if (d < 1500 && (!best || d < best.d)) best = { v, d };
          }
          if (!best) continue;
          const t = day.tripByRef.get(best.v.tripRef);
          if (t !== undefined && day.tripPat[t] === c.pattern) c.trip = t;
          const est = this.vehicleProgress(day, c.trip, best.v, date);
          if (est) {
            c.delay = est.delay;
            c.live = true;
            c.schedAtNext = tripTime(day, c.trip, c.nextPos);
          }
        }
      } catch { /* live data optional */ }
    }
    return out.slice(0, 8);
  }

  async busStops(date: string, pattern: number, trip: number) {
    const { day } = await this.getDay(date);
    const n = patLen(day, pattern);
    const out: StopRef[] = [];
    for (let i = 0; i < n; i++) {
      const s = patStop(day, pattern, i);
      out.push({ stop: s, name: this.net.stops.name[s], lat: this.net.lat[s], lon: this.net.lon[s], code: this.net.stops.code[s], t: tripTime(day, trip, i) });
    }
    return out;
  }

  async planOnBus(req: PlanRequest): Promise<PlanResponse> {
    const b = req.bus!;
    const { day, raptor } = await this.getDay(b.date);
    const { sec } = this.when(req);
    const t0 = b.date === israelParts(req.time ?? Date.now()).ymd ? sec : epochToDaySec(req.time ?? Date.now(), b.date);
    const here: Place = req.from ?? this.stopPlace(patStop(day, b.pattern, Math.max(0, b.nextPos - 1)));
    const ctx = this.baseCtx(day, raptor, req.prefs, t0);
    ctx.bus = { ...b, here };
    const n = patLen(day, b.pattern);
    for (let j = b.nextPos; j < n; j++) {
      ctx.accInfo.push({ kind: 'onbus', pos: j });
      ctx.acc.push({ stop: patStop(day, b.pattern, j), time: Math.max(t0, tripTime(day, b.trip, j) + b.delay), tag: ctx.accInfo.length - 1 });
    }
    this.addWalkEgress(ctx, req.to);
    const results = this.run(ctx).map((r) => this.build(ctx, r));
    const its = this.pareto(results, 4);
    for (const it of its) {
      const first = it.legs[0];
      if (first?.onBus) it.tags.unshift(`לרדת ב${first.to.name}`);
    }
    return { date: b.date, itineraries: its };
  }

  // ---------------------------------------------------------------- live helpers

  /** Locate a live vehicle along its trip's stops and compute its delay. */
  vehicleProgress(day: Day, trip: number, v: Vehicle, date: string) {
    const p = day.tripPat[trip];
    const n = patLen(day, p);
    const rec = epochToDaySec(v.recordedAt, date);
    let best = { seg: -1, frac: 0, score: Infinity };
    for (let i = 0; i < n - 1; i++) {
      const a = patStop(day, p, i), b = patStop(day, p, i + 1);
      const la1 = this.net.lat[a], lo1 = this.net.lon[a], la2 = this.net.lat[b], lo2 = this.net.lon[b];
      const pr = projectOnLine([[la1, lo1], [la2, lo2]], v.lat, v.lon);
      if (pr.dist > 1200) continue;
      const ts = tripTime(day, trip, i) + pr.frac * (tripTime(day, trip, i + 1) - tripTime(day, trip, i));
      const score = pr.dist + Math.abs(rec - ts) / 10; // prefer plausible time
      if (score < best.score) best = { seg: i, frac: pr.frac, score };
    }
    if (best.seg < 0) return null;
    const i = best.seg;
    const sched = tripTime(day, trip, i) + best.frac * (tripTime(day, trip, i + 1) - tripTime(day, trip, i));
    return { delay: Math.round(rec - sched), pos: i + best.frac };
  }

  /** Stop coordinates mapped onto the route shape, for placing buses along real roads. */
  private patternGeom(day: Day, p: number): Promise<PatGeom> {
    const key = day.date + ':' + p;
    let g = this.geomCache.get(key);
    if (!g) {
      g = (async () => {
        const n = patLen(day, p);
        const stops: LatLon[] = [];
        for (let i = 0; i < n; i++) { const s = patStop(day, p, i); stops.push([this.net.lat[s], this.net.lon[s]]); }
        const sh = day.patShape[p] >= 0 ? await this.shapeCoords(day.patShape[p]) : null;
        const pts = sh && sh.length > 1 ? sh : stops;
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + distM(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
        const stopD: number[] = [];
        let seg = 0;
        for (const [la, lo] of stops) {
          // search forward only, so loops in the route don't confuse the mapping
          let best = { d: Infinity, at: cum[seg], k: seg };
          for (let k = seg; k < Math.min(pts.length - 1, seg + 600); k++) {
            const pr = projectOnLine([pts[k], pts[k + 1]], la, lo);
            if (pr.dist < best.d) best = { d: pr.dist, at: cum[k] + pr.frac * (cum[k + 1] - cum[k]), k };
            if (best.d < 15 && pr.dist > 400) break;
          }
          seg = best.k;
          stopD.push(Math.max(best.at, stopD.length ? stopD[stopD.length - 1] : 0));
        }
        return { pts, cum, stopD };
      })();
      this.geomCache.set(key, g);
      if (this.geomCache.size > 400) this.geomCache.delete(this.geomCache.keys().next().value as string);
    }
    return g;
  }

  /**
   * Where the bus is *now*. The feed is minutes old, so we move the bus forward
   * along its route at the scheduled pace, keeping its measured delay.
   */
  async vehicleNow(day: Day, trip: number, v: Vehicle, date: string): Promise<{ lat: number; lon: number; bearing: number; pos: number; delay: number } | null> {
    const est = this.vehicleProgress(day, trip, v, date);
    if (!est) return null;
    const p = day.tripPat[trip];
    const n = patLen(day, p);
    const tau = epochToDaySec(Date.now(), date) - est.delay; // the schedule time the bus is at now
    if (tau - tripTime(day, trip, n - 1) > 120) return null; // trip finished
    let i = 0;
    while (i < n - 1 && tripTime(day, trip, i + 1) <= tau) i++;
    let pos = i;
    if (i < n - 1) {
      const a = tripTime(day, trip, i), b = tripTime(day, trip, i + 1);
      pos = i + (b > a ? Math.max(0, Math.min(1, (tau - a) / (b - a))) : 0);
    }
    pos = Math.min(n - 1, Math.max(pos, est.pos)); // never move a bus backwards
    const g = await this.patternGeom(day, p);
    const k = Math.min(n - 2, Math.floor(pos));
    const d = g.stopD[k] + (pos - k) * (g.stopD[k + 1] - g.stopD[k]);
    const pt = pointAt(g, d);
    if (distM(pt[0], pt[1], v.lat, v.lon) > 4000) return { lat: v.lat, lon: v.lon, bearing: v.bearing, pos: est.pos, delay: est.delay };
    return { lat: pt[0], lon: pt[1], bearing: pt[2], pos, delay: est.delay };
  }

  private async vehicleView(day: Day, date: string, trip: number, v: Vehicle): Promise<VehicleView | null> {
    const now = await this.vehicleNow(day, trip, v, date);
    if (!now) return null;
    const p = day.tripPat[trip];
    const r = this.net.routes[day.patRoute[p]];
    const next = patStop(day, p, Math.min(patLen(day, p) - 1, Math.ceil(now.pos)));
    return {
      lat: now.lat, lon: now.lon, bearing: now.bearing, line: r[1] || 'רכבת', color: lineColor(r[4], r[5], r[6]), delay: now.delay,
      ageSec: Math.round((Date.now() - v.recordedAt) / 1000), tripRef: v.tripRef, trip, route: day.patRoute[p], rtype: r[5],
      headsign: this.net.headsigns[day.patHead[p]] || r[3], nextStop: this.net.stops.name[next], pos: now.pos,
    };
  }

  async departures(stop: number, timeMs?: number, horizonMin = 90, withLive = true): Promise<Departure[]> {
    return (await this.stopBoard(stop, timeMs, horizonMin, withLive)).deps;
  }

  /** Departures from a stop (live where available) plus the approaching buses for the map. */
  async stopBoard(stop: number, timeMs?: number, horizonMin = 90, withLive = true): Promise<{ deps: Departure[]; vehicles: VehicleView[] }> {
    const { date, sec } = this.when({ time: timeMs } as PlanRequest);
    const { day } = await this.getDay(date);
    const net = this.net;
    const out: Departure[] = [];
    const vehicles: VehicleView[] = [];
    for (let j = day.spOff[stop]; j < day.spOff[stop + 1]; j++) {
      const p = day.spPat[j], pos = day.spPos[j];
      const n = patLen(day, p);
      if (pos === n - 1) continue; // final stop: no departures
      const r = net.routes[day.patRoute[p]];
      const t0 = day.patTripOff[p], t1 = day.patTripOff[p + 1];
      let lo = t0, hi = t1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tripTime(day, mid, pos) >= sec - 20 * 60) hi = mid; else lo = mid + 1;
      }
      for (let t = lo; t < t1; t++) {
        const tt = tripTime(day, t, pos);
        if (tt > sec + horizonMin * 60) break;
        out.push({
          pattern: p, trip: t, tripRef: day.tripRef[t], pos, time: tt, sched: tt, live: false,
          route: day.patRoute[p], gtfsRoute: r[0], line: r[1] || 'רכבת', rtype: r[5], agency: r[4],
          headsign: net.headsigns[day.patHead[p]] || r[3], color: lineColor(r[4], r[5], r[6]),
        });
      }
    }
    if (withLive && out.length) {
      try {
        // live data for the lines with the soonest departures
        const soon = [...out].sort((a, b) => a.time - b.time);
        const ids: number[] = [];
        for (const d of soon) if (!ids.includes(d.gtfsRoute)) ids.push(d.gtfsRoute);
        const vs = await vehiclesForRoutes(ids.slice(0, 16));
        const byRef = new Map<number, Vehicle>();
        for (const v of vs) byRef.set(v.tripRef, v);
        await Promise.all(out.map(async (d) => {
          const v = byRef.get(d.tripRef);
          if (!v) return;
          const now = await this.vehicleNow(day, d.trip, v, date);
          if (!now) return;
          if (now.pos > d.pos + 0.15) { d.time = -1; return; } // already passed this stop
          d.time = d.sched + now.delay;
          d.live = true;
          d.stopsAway = Math.max(0, Math.ceil(d.pos - now.pos - 0.15));
          if (d.time - sec < 40 * 60) {
            const vv = await this.vehicleView(day, date, d.trip, v);
            if (vv) vehicles.push(vv);
          }
        }));
      } catch { /* live data is optional */ }
    }
    const deps = out.filter((d) => d.time >= sec - 60 && (d.live || d.time >= sec - 30)).sort((a, b) => a.time - b.time).slice(0, 60);
    return { deps, vehicles };
  }

  async liveForLeg(date: string, trip: number, gtfsRoute: number, boardPos?: number): Promise<{ delay: number; pos: number; stopsAway?: number; v: VehicleView } | null> {
    const { day } = await this.getDay(date);
    const vs = await vehiclesForRoute(gtfsRoute);
    const v = vs.find((x) => x.tripRef === day.tripRef[trip]);
    if (!v) return null;
    const vv = await this.vehicleView(day, date, trip, v);
    if (!vv) return null;
    const stopsAway = boardPos !== undefined && vv.pos! <= boardPos + 0.15 ? Math.max(0, Math.ceil(boardPos - vv.pos! - 0.15)) : undefined;
    return { delay: vv.delay ?? 0, pos: vv.pos!, stopsAway, v: vv };
  }

  async vehiclesOnRoute(date: string, route: number): Promise<VehicleView[]> {
    const { day } = await this.getDay(date);
    const r = this.net.routes[route];
    const vs = await vehiclesForRoute(r[0]);
    const out = await Promise.all(vs.map(async (v) => {
      const t = day.tripByRef.get(v.tripRef);
      if (t === undefined) return null;
      return this.vehicleView(day, date, t, v);
    }));
    return out.filter((x): x is VehicleView => !!x);
  }

  // ---------------------------------------------------------------- search & geometry

  searchStops(q: string, near?: LatLon, limit = 12) {
    const norm = (s: string) => s.replace(/["'`״׳\-/.,]/g, ' ').replace(/\s+/g, ' ').trim();
    const nq = norm(q);
    if (!nq) return [];
    const isCode = /^\d{3,6}$/.test(nq);
    const st = this.net.stops;
    const words = nq.split(' ');
    const hits: [number, number][] = [];
    for (let s = 0; s < this.net.nStops; s++) {
      let score: number;
      if (isCode) {
        if (String(st.code[s]) !== nq) continue;
        score = 0;
      } else {
        const name = norm(st.name[s] + ' ' + st.city[s]);
        if (!words.every((w) => name.includes(w))) continue;
        score = name.startsWith(words[0]) ? 0 : 1000;
        if (near) score += distM(near[0], near[1], st.lat[s], st.lon[s]) / 100;
      }
      hits.push([s, score]);
    }
    hits.sort((a, b) => a[1] - b[1]);
    return hits.slice(0, limit).map(([s]) => this.stopPlace(s));
  }

  async nearbyStops(lat: number, lon: number, radius = 700, limit = 12) {
    const { date } = this.when({} as PlanRequest);
    const { day } = await this.getDay(date);
    const net = this.net;
    const res = [];
    for (const [s, d] of net.grid.near(lat, lon, radius, 80)) {
      if (day.spOff[s + 1] === day.spOff[s]) continue;
      const lines = new Map<string, string>();
      for (let j = day.spOff[s]; j < day.spOff[s + 1]; j++) {
        const r = net.routes[day.patRoute[day.spPat[j]]];
        lines.set(r[1] || 'רכבת', lineColor(r[4], r[5], r[6]));
      }
      res.push({ place: this.stopPlace(s), dist: Math.round(d), lines: [...lines].slice(0, 14) });
      if (res.length >= limit) break;
    }
    return res;
  }

  async searchLines(q: string, near?: LatLon): Promise<LineVariant[]> {
    const { date } = this.when({} as PlanRequest);
    const { day } = await this.getDay(date);
    const net = this.net;
    const out: LineVariant[] = [];
    const qq = q.trim();
    if (!qq) return out;
    for (const [ri, pats] of day.routePats) {
      const r = net.routes[ri];
      if (r[1] !== qq) continue;
      // distance from me to the closest stop on this line (nearest lines first, like other apps)
      let distM_ = Infinity;
      if (near) {
        for (const p of pats) for (let i = 0; i < patLen(day, p); i++) {
          const st = patStop(day, p, i);
          const d = distM(near[0], near[1], net.lat[st], net.lon[st]);
          if (d < distM_) distM_ = d;
        }
      }
      out.push({ route: ri, gtfsRoute: r[0], line: r[1], agency: r[4], agencyName: net.agencies[r[4]] || '', rtype: r[5], from: r[2], to: r[3], patterns: pats, color: lineColor(r[4], r[5], r[6]), distM: isFinite(distM_) ? Math.round(distM_) : undefined });
    }
    out.sort((a, b) => (a.distM ?? 0) - (b.distM ?? 0) || a.agency - b.agency || a.from.localeCompare(b.from));
    return out;
  }

  async patternDetail(route: number, timeMs?: number) {
    const { date, sec } = this.when({ time: timeMs } as PlanRequest);
    const { day } = await this.getDay(date);
    const pats = day.routePats.get(route) || [];
    // pick the pattern with most trips
    let p = pats[0];
    let maxT = -1;
    for (const x of pats) {
      const c = day.patTripOff[x + 1] - day.patTripOff[x];
      if (c > maxT) { maxT = c; p = x; }
    }
    if (p === undefined) return null;
    const n = patLen(day, p);
    const stops = [];
    for (let i = 0; i < n; i++) stops.push(this.stopPlace(patStop(day, p, i)));
    // departures from first stop today
    const deps: number[] = [];
    for (const x of pats) for (let t = day.patTripOff[x]; t < day.patTripOff[x + 1]; t++) deps.push(tripTime(day, t, 0));
    deps.sort((a, b) => a - b);
    const shape = day.patShape[p];
    return { date, pattern: p, stops, departures: deps, nowSec: sec, shape: shape >= 0 ? await this.shapeCoords(shape) : null };
  }

  async shapeCoords(shape: number): Promise<LatLon[] | null> {
    try {
      const b = await loadShapeBucket(this.load, this.net, shape);
      const enc = b[String(shape)];
      return enc ? decodePolyline(enc) : null;
    } catch {
      return null;
    }
  }

  /** Geometry for each leg of an itinerary (bus shapes, car routes). */
  async legGeometry(legs: Leg[]): Promise<LatLon[][]> {
    const out: LatLon[][] = [];
    for (const l of legs) {
      const a: LatLon = [l.from.lat, l.from.lon], b: LatLon = [l.to.lat, l.to.lon];
      if (l.kind === 'transit') {
        let g: LatLon[] | null = null;
        if (l.shape !== undefined && l.shape >= 0) {
          const sh = await this.shapeCoords(l.shape);
          if (sh) {
            const first = l.stops![0], last = l.stops![l.stops!.length - 1];
            g = slicePolyline(sh, [first.lat, first.lon], [last.lat, last.lon]);
            if (l.onBus) g = slicePolyline(sh, a, [last.lat, last.lon]);
          }
        }
        out.push(g ?? l.stops!.map((s) => [s.lat, s.lon] as LatLon));
      } else if (l.kind === 'car') {
        if (l.geometry && l.geometry.length > 1) out.push(l.geometry);
        else {
          try {
            const pts: LatLon[] = l.car?.driverFrom && l.car.role === 'pickup' ? [a, b] : [a, b];
            out.push((await osrmRoute(pts)).coords);
          } catch { out.push([a, b]); }
        }
      } else if (l.kind === 'walk' && (l.dist ?? 0) > 60) {
        try { out.push(await footRoute(a, b)); } catch { out.push([a, b]); }
      } else out.push([a, b]);
    }
    return out;
  }
}

/** Point (and heading) at distance d along a pattern's geometry. */
function pointAt(g: PatGeom, d: number): [number, number, number] {
  const { pts, cum } = g;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[Math.min(pts.length - 1, lo + 1)];
  const seg = cum[Math.min(cum.length - 1, lo + 1)] - cum[lo];
  const f = seg > 0 ? Math.max(0, Math.min(1, (d - cum[lo]) / seg)) : 0;
  const lat = a[0] + (b[0] - a[0]) * f, lon = a[1] + (b[1] - a[1]) * f;
  const brg = (Math.atan2((b[1] - a[1]) * Math.cos((lat * Math.PI) / 180), b[0] - a[0]) * 180) / Math.PI;
  return [lat, lon, (brg + 360) % 360];
}

/** Joins consecutive walking legs (stop-to-stop transfer + final walk) into one. */
function mergeWalks(legs: Leg[], prefs: Prefs): Leg[] {
  const out: Leg[] = [];
  for (const l of legs) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'walk' && l.kind === 'walk') {
      const direct = Math.round(distM(prev.from.lat, prev.from.lon, l.to.lat, l.to.lon) * WALK_FACTOR);
      const dist = Math.min(direct, (prev.dist || 0) + (l.dist || 0));
      out[out.length - 1] = { ...prev, to: l.to, dist, arr: prev.dep + Math.round(dist / prefs.walkSpeed) };
    } else out.push(l);
  }
  // drop negligible walks
  return out.filter((l, i) => !(l.kind === 'walk' && (l.dist ?? 0) < 25 && out.length > 1 && i > 0 && i < out.length - 1));
}

function hmLocal(sec: number) {
  const m = Math.round(sec / 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function hasCar(it: Itinerary) {
  return it.legs.some((l) => l.kind === 'car');
}

function carSec(it: Itinerary) {
  return it.legs.reduce((a, l) => a + (l.car ? (l.car.driverTotalSec ?? l.car.detourSec ?? l.car.driveSec) : 0), 0);
}
