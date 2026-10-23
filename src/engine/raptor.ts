import type { Day, Net } from './data';

/**
 * RAPTOR (Round-bAsed Public Transit Optimized Router), multi-source / multi-target.
 * Every "flexible" scenario (car pickup, ride-along, already-on-a-bus) is expressed as a set of
 * access entries (stop + time you can be there) and egress entries (stop + extra time/cost to finish).
 */

export interface Access { stop: number; time: number; tag: number }
export interface Egress { stop: number; dur: number; pen: number; tag: number }

export interface RaptorOpts {
  maxRounds: number; // max number of vehicles boarded
  slack: number; // seconds needed for a same-stop transfer
  walkSpeed: number; // m/s
  maxTime: number; // ignore arrivals after this
}

export type RawLeg =
  | { t: 'access'; tag: number; stop: number; time: number }
  | { t: 'transit'; trip: number; pat: number; board: number; alight: number; dep: number; arr: number }
  | { t: 'walk'; from: number; to: number; dep: number; arr: number; dist: number };

export interface RoundResult { round: number; egress: number; arr: number; cost: number; legs: RawLeg[] }

const INF = 0x3fffffff;
const T_ACCESS = 1, T_TRANSIT = 2, T_WALK = 3;

export class Raptor {
  readonly n: number;
  private K = 0;
  tau!: Int32Array;
  private best: Int32Array;
  private lType!: Uint8Array;
  private lA!: Int32Array;
  private lB!: Int32Array;
  private lC!: Int32Array;
  private marked: Uint8Array;
  private markedList: Int32Array;
  private nMarked = 0;
  private qPos: Int32Array;
  private qList: Int32Array;

  constructor(private net: Net, private day: Day) {
    this.n = net.nStops;
    this.best = new Int32Array(this.n);
    this.marked = new Uint8Array(this.n);
    this.markedList = new Int32Array(this.n);
    this.qPos = new Int32Array(day.nPat).fill(-1);
    this.qList = new Int32Array(day.nPat);
  }

  private alloc(K: number) {
    if (this.K === K) return;
    this.K = K;
    const sz = (K + 1) * this.n;
    this.tau = new Int32Array(sz);
    this.lType = new Uint8Array(sz);
    this.lA = new Int32Array(sz);
    this.lB = new Int32Array(sz);
    this.lC = new Int32Array(sz);
  }

  private mark(s: number) {
    if (!this.marked[s]) { this.marked[s] = 1; this.markedList[this.nMarked++] = s; }
  }

  /**
   * Runs the search. When egress is null, runs one-to-all (bounded by maxTime) and the caller reads `arrivalAt`.
   */
  run(access: Access[], egress: Egress[] | null, o: RaptorOpts): RoundResult[] {
    const { n, day } = this;
    const K = o.maxRounds;
    this.alloc(K);
    const tau = this.tau, best = this.best, lType = this.lType, lA = this.lA, lB = this.lB, lC = this.lC;
    tau.fill(INF);
    lType.fill(0);
    best.fill(INF);
    this.nMarked = 0;
    this.marked.fill(0);

    // egress lookup
    const egByStop = new Map<number, Egress[]>();
    if (egress) for (const e of egress) {
      let l = egByStop.get(e.stop);
      if (!l) egByStop.set(e.stop, (l = []));
      l.push(e);
    }
    let bound = o.maxTime;
    const results: RoundResult[] = [];
    let bestCost = INF;

    // round 0: access
    for (let i = 0; i < access.length; i++) {
      const a = access[i];
      if (a.time < tau[a.stop]) {
        tau[a.stop] = a.time;
        best[a.stop] = a.time;
        lType[a.stop] = T_ACCESS;
        lA[a.stop] = i;
        this.mark(a.stop);
      }
    }
    this.footpaths(0, bound, true, o.walkSpeed);

    const { patStopOff, patTripOff, patStops, patTimeOff, times, spOff, spPat, spPos } = day;
    for (let k = 1; k <= K; k++) {
      // collect routes
      let nQ = 0;
      const qPos = this.qPos, qList = this.qList;
      for (let m = 0; m < this.nMarked; m++) {
        const s = this.markedList[m];
        this.marked[s] = 0;
        for (let j = spOff[s]; j < spOff[s + 1]; j++) {
          const p = spPat[j], pos = spPos[j];
          if (qPos[p] < 0) { qPos[p] = pos; qList[nQ++] = p; }
          else if (pos < qPos[p]) qPos[p] = pos;
        }
      }
      this.nMarked = 0;
      if (nQ === 0) break;
      const prev = (k - 1) * n, cur = k * n;

      for (let qi = 0; qi < nQ; qi++) {
        const p = qList[qi];
        const start = qPos[p];
        qPos[p] = -1;
        const so = patStopOff[p];
        const ns = patStopOff[p + 1] - so;
        const t0 = patTripOff[p], t1 = patTripOff[p + 1];
        const to = patTimeOff[p];
        let trip = -1, tbase = 0, boardPos = -1;
        for (let i = start; i < ns; i++) {
          const s = patStops[so + i];
          if (trip >= 0) {
            const arr = times[tbase + i];
            if (arr < best[s] && arr < bound) {
              tau[cur + s] = arr;
              best[s] = arr;
              lType[cur + s] = T_TRANSIT;
              lA[cur + s] = trip;
              lB[cur + s] = boardPos;
              lC[cur + s] = i;
              this.mark(s);
            }
          }
          // can we board an earlier trip here?
          const ty = lType[prev + s];
          if (ty) {
            const ready = tau[prev + s] + (ty === T_TRANSIT ? o.slack : ty === T_WALK ? 30 : 0);
            if (trip < 0 || ready <= times[tbase + i]) {
              // binary search earliest trip with time >= ready at position i
              let lo = t0, hi = (trip >= 0 ? trip : t1);
              while (lo < hi) {
                const mid = (lo + hi) >> 1;
                if (times[to + (mid - t0) * ns + i] >= ready) hi = mid; else lo = mid + 1;
              }
              if (lo < t1 && (trip < 0 || lo < trip)) {
                trip = lo;
                tbase = to + (lo - t0) * ns;
                boardPos = i;
              }
            }
          }
        }
      }
      this.footpaths(k, bound, false, o.walkSpeed);

      // evaluate egress for this round
      if (egress) {
        let roundBest: RoundResult | null = null;
        for (const [s, list] of egByStop) {
          const a = tau[cur + s];
          if (a >= INF) continue;
          for (const e of list) {
            const c = a + e.dur + e.pen;
            if (c < bestCost && (!roundBest || c < roundBest.cost)) {
              roundBest = { round: k, egress: e.tag, arr: a + e.dur, cost: c, legs: [] };
              (roundBest as any)._stop = s;
            }
          }
        }
        if (roundBest) {
          roundBest.legs = this.reconstruct(k, (roundBest as any)._stop, access);
          delete (roundBest as any)._stop;
          results.push(roundBest);
          bestCost = roundBest.cost;
          bound = Math.min(bound, bestCost);
        }
      }
    }
    // egress straight from access (no vehicle) — e.g. drop-off right next to destination
    if (egress) {
      for (const [s, list] of egByStop) {
        if (lType[s] !== T_ACCESS && lType[s] !== T_WALK) continue;
        for (const e of list) {
          const c = tau[s] + e.dur + e.pen;
          if (c < bestCost) {
            results.unshift({ round: 0, egress: e.tag, arr: tau[s] + e.dur, cost: c, legs: this.reconstruct(0, s, access) });
            bestCost = c;
          }
        }
      }
    }
    return results;
  }

  private footpaths(k: number, bound: number, fromAccess: boolean, speed: number) {
    const { n } = this;
    const { footOff, footTo, footDist } = this.net;
    const cur = k * n;
    const tau = this.tau, best = this.best, lType = this.lType;
    const cnt = this.nMarked;
    for (let m = 0; m < cnt; m++) {
      const s = this.markedList[m];
      const ty = lType[cur + s];
      if (ty !== (fromAccess ? T_ACCESS : T_TRANSIT)) continue;
      const base = tau[cur + s];
      for (let j = footOff[s]; j < footOff[s + 1]; j++) {
        const t = footTo[j];
        const arr = base + Math.round(footDist[j] / speed);
        if (arr < best[t] && arr < bound) {
          tau[cur + t] = arr;
          best[t] = arr;
          lType[cur + t] = T_WALK;
          this.lA[cur + t] = s;
          this.lB[cur + t] = footDist[j];
          this.mark(t);
        }
      }
    }
  }

  /** earliest arrival at stop over all rounds (after a one-to-all run) */
  arrivalAt(s: number) {
    const v = this.best[s];
    return v >= INF ? -1 : v;
  }

  /** round in which the best arrival at s was achieved */
  bestRound(s: number) {
    let r = -1, v = INF;
    for (let k = 0; k <= this.K; k++) {
      const a = this.tau[k * this.n + s];
      if (this.lType[k * this.n + s] && a < v) { v = a; r = k; }
    }
    return r;
  }

  reconstruct(k: number, s: number, access: Access[]): RawLeg[] {
    const { n, day } = this;
    const legs: RawLeg[] = [];
    let guard = 0;
    while (guard++ < 50) {
      const idx = k * n + s;
      const ty = this.lType[idx];
      if (ty === T_WALK) {
        const from = this.lA[idx];
        const arr = this.tau[idx];
        const dist = this.lB[idx];
        legs.push({ t: 'walk', from, to: s, arr, dep: this.tau[k * n + from], dist });
        s = from;
      } else if (ty === T_TRANSIT) {
        const trip = this.lA[idx], board = this.lB[idx], alight = this.lC[idx];
        const p = day.tripPat[trip];
        const ns = day.patStopOff[p + 1] - day.patStopOff[p];
        const tb = day.patTimeOff[p] + (trip - day.patTripOff[p]) * ns;
        legs.push({ t: 'transit', trip, pat: p, board, alight, dep: day.times[tb + board], arr: day.times[tb + alight] });
        s = day.patStops[day.patStopOff[p] + board];
        k--;
      } else if (ty === T_ACCESS) {
        const a = access[this.lA[idx]];
        legs.push({ t: 'access', tag: a.tag, stop: s, time: a.time });
        break;
      } else {
        throw new Error('broken label chain');
      }
    }
    return legs.reverse();
  }
}
