import fs from 'node:fs';
import path from 'node:path';
import { loadNet } from '../src/engine/data';
import { Planner } from '../src/engine/planner';
import { DEFAULT_PREFS } from '../src/engine/model';
import { hm } from '../src/engine/time';
const dir = path.resolve('public/data');
const load = async (p: string) => { const b = fs.readFileSync(path.join(dir, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
(async () => {
  const pl = new Planner(await loadNet(load), load);
  const key = process.env.TT_KEY || 'FAKEKEY123';
  const r = await pl.planPickup({ mode: 'pickup', from: { name: 'RG', lat: 32.07, lon: 34.824 }, to: { name: 'KS', lat: 32.176, lon: 34.907 }, driver: { name: 'KS', lat: 32.176, lon: 34.907 }, maxDriveMin: 10, lambda: 0.3, time: Date.parse('2026-10-25T14:00:00+02:00'), prefs: DEFAULT_PREFS, trafficKey: key });
  console.log('traffic:', r.traffic);
  for (const it of r.itineraries) console.log(hm(it.dep), '->', hm(it.arr), it.tags.join(','), it.legs.filter((l) => l.car).map((l) => JSON.stringify({ drive: l.car!.driveSec, leaves: l.car!.driverLeaves && hm(l.car!.driverLeaves), total: l.car!.driverTotalSec, traffic: l.car!.traffic, warn: l.car!.warn })).join(' '));
})();
