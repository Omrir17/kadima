import fs from 'node:fs';
import path from 'node:path';
import { loadNet } from '../src/engine/data';
import { Planner } from '../src/engine/planner';
import { DEFAULT_PREFS, Itinerary, Place } from '../src/engine/model';
import { hm } from '../src/engine/time';

const dir = path.resolve('public/data');
const load = async (p: string) => { const b = fs.readFileSync(path.join(dir, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };

function show(title: string, its: Itinerary[], baseline?: Itinerary | null) {
  console.log('\n=== ' + title);
  for (const it of its) {
    console.log(`  ${hm(it.dep)} -> ${hm(it.arr)}  (${Math.round((it.arr - it.dep) / 60)}m, ${it.transfers}x) [${it.tags.join(',')}]`);
    for (const l of it.legs) {
      const what = l.kind === 'transit' ? `${l.onBus ? 'ON BUS ' : ''}${l.line} (${l.agencyName}) to ${l.headsign}` : l.kind === 'car' ? `CAR ${l.car?.role} ${Math.round(l.car!.driveSec / 60)}m driverLeaves=${l.car?.driverLeaves ? hm(l.car.driverLeaves) : '-'} detour=${l.car?.detourSec ?? '-'}` : `walk ${l.dist}m`;
      console.log(`     ${hm(l.dep)}-${hm(l.arr)} ${what}: ${l.from.name} -> ${l.to.name}`);
    }
  }
  if (baseline) console.log(`  baseline transit: ${hm(baseline.dep)} -> ${hm(baseline.arr)}`);
}

const P = (name: string, lat: number, lon: number): Place => ({ name, lat, lon });
const azrieli = P('עזריאלי', 32.0744, 34.7920);
const ptCenter = P('פתח תקווה מרכז', 32.0889, 34.8864);
const kfarSabaHome = P('בית כפר סבא', 32.1760, 34.9070);
const ramatGanSchool = P('בית ספר רמת גן', 32.0700, 34.8240);
const roshHaayin = P('ראש העין', 32.0956, 34.9566);

(async () => {
  let t = Date.now();
  const net = await loadNet(load);
  console.log('net loaded', Date.now() - t, 'ms; stops', net.nStops, 'foot', net.footTo.length);
  const pl = new Planner(net, load);
  const time = Date.parse('2026-10-25T08:00:00+02:00');
  t = Date.now();
  await pl.getDay('2026-10-25');
  console.log('day loaded', Date.now() - t, 'ms');
  const prefs = DEFAULT_PREFS;

  t = Date.now();
  let r = await pl.planTransit({ mode: 'transit', from: azrieli, to: ptCenter, time, prefs });
  console.log('transit took', Date.now() - t, 'ms');
  show('transit Azrieli -> PT', r.itineraries);

  t = Date.now();
  r = await pl.planTransit({ mode: 'transit', from: azrieli, to: P('ירושלים מרכז', 31.7838, 35.2032), time: Date.parse('2026-10-25T10:00:00+02:00'), arriveBy: true, prefs });
  console.log('arriveBy took', Date.now() - t, 'ms');
  show('arrive-by 10:00 Azrieli -> Jerusalem', r.itineraries);

  t = Date.now();
  r = await pl.planPickup({ mode: 'pickup', from: ramatGanSchool, to: kfarSabaHome, driver: kfarSabaHome, maxDriveMin: 10, lambda: 0.3, time: Date.parse('2026-10-25T14:00:00+02:00'), prefs });
  console.log('pickup took', Date.now() - t, 'ms approx=', r.approx);
  show('pickup RG school -> KS home, mom 10min', r.itineraries, r.baseline);

  t = Date.now();
  r = await pl.planDropoff({ mode: 'dropoff', from: kfarSabaHome, driver: kfarSabaHome, to: azrieli, maxDriveMin: 10, lambda: 0.3, time, prefs });
  console.log('dropoff took', Date.now() - t, 'ms');
  show('dropoff KS home -> Azrieli', r.itineraries, r.baseline);

  t = Date.now();
  r = await pl.planRide({ mode: 'ride', from: azrieli, rideDest: roshHaayin, to: ptCenter, detourMin: 5, time: Date.parse('2026-10-25T17:00:00+02:00'), prefs });
  console.log('ride took', Date.now() - t, 'ms');
  show('ride Azrieli->Rosh HaAyin, going to PT', r.itineraries);

  t = Date.now();
  const cands = await pl.findBuses('1', [32.0800, 34.7810], Date.parse('2026-10-25T09:00:00+02:00'));
  console.log('\nfindBuses took', Date.now() - t, 'ms', cands.slice(0, 4).map((c) => `${c.line} ${c.agencyName} -> ${c.headsign} next=${c.nextStopName} d=${c.distM} sched=${hm(c.schedAtNext)}`));
  if (cands[0]) {
    const c = cands[0];
    r = await pl.planOnBus({ mode: 'onbus', to: ptCenter, bus: { date: c.date, pattern: c.pattern, trip: c.trip, nextPos: c.nextPos, delay: 0 }, time: Date.parse('2026-10-25T09:00:00+02:00'), prefs });
    show('on bus ' + c.line + ' -> PT', r.itineraries);
  }
  const deps = await pl.departures(pl.searchStops('עזריאלי')[0].stop!, Date.parse('2026-10-25T09:00:00+02:00'), 30, false);
  console.log('\ndepartures', deps.slice(0, 6).map((d) => `${d.line}->${d.headsign} ${hm(d.time)}`));
})();
