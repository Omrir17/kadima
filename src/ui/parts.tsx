import { useEffect, useState } from 'react';
import type { Itinerary, Leg } from '../engine/model';
import { epochToDaySec, hm, israelNow, mins } from '../engine/time';
import { IconCar, IconWalk, ModeIcon } from './icons';

export const RIDE = '#7b2ff7';
export const WALK = '#7d8794';

/** current service-day seconds for a date, ticking every 20s */
export function useNowSec(date?: string) {
  const [, setT] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setT((x) => x + 1), 20000);
    return () => clearInterval(i);
  }, []);
  return epochToDaySec(Date.now(), date ?? israelNow().ymd);
}

export function LineBadge({ line, color, rtype, size = 'm' }: { line?: string; color?: string; rtype?: number; size?: 's' | 'm' | 'l' }) {
  return (
    <span className={'badge badge-' + size} style={{ background: color || '#5a6b7d' }}>
      <ModeIcon rtype={rtype} size={size === 's' ? 13 : size === 'l' ? 18 : 15} />
      {line && <b>{line}</b>}
    </span>
  );
}

export function inMinutes(sec: number, now: number) {
  const m = Math.round((sec - now) / 60);
  if (m <= 0) return 'עכשיו';
  if (m < 60) return `${m} דק'`;
  return hm(sec);
}

export function legColor(l: Leg) {
  if (l.kind === 'walk') return WALK;
  if (l.kind === 'car') return RIDE;
  return l.color || '#5a6b7d';
}

export function LegChips({ it }: { it: Itinerary }) {
  const out: JSX.Element[] = [];
  it.legs.filter((l) => !(l.kind === 'walk' && l.arr - l.dep < 50 && it.legs.length > 1)).forEach((l, i) => {
    if (i > 0) out.push(<span key={'s' + i} className="chip-sep" />);
    if (l.kind === 'walk') out.push(<span key={i} className="chip chip-walk"><IconWalk size={15} />{mins(l.arr - l.dep)}</span>);
    else if (l.kind === 'car') out.push(<span key={i} className="chip chip-car"><IconCar size={15} />{mins(l.car?.driveSec ?? l.arr - l.dep)}</span>);
    else out.push(<LineBadge key={i} line={l.line} color={l.color} rtype={l.rtype} size="s" />);
  });
  return <div className="chips">{out}</div>;
}

function carHeadline(it: Itinerary): string | null {
  const car = it.legs.find((l) => l.kind === 'car');
  if (!car?.car) return null;
  const c = car.car;
  if (c.role === 'pickup') return `איסוף ב${car.from.name} ב-${hm(car.dep)}`;
  if (c.role === 'dropoff') return it.legs.length === 1 ? `הנהג לוקח אותך עד היעד` : `הקפצה ל${car.to.name}`;
  if (it.legs.length === 1) return `הנהג מוריד אותך ביעד`;
  return `לרדת מהרכב ב${car.to.name.replace(/^ליד /, 'ליד ')}`;
}

export function ItinCard({ it, now, onClick, baseline }: { it: Itinerary; now: number; onClick: () => void; baseline?: Itinerary | null }) {
  const firstTransit = it.legs.find((l) => l.kind === 'transit');
  const leaveIn = Math.round((it.dep - now) / 60);
  const head = carHeadline(it);
  const saving = baseline ? Math.round((baseline.arr - it.arr) / 60) : 0;
  return (
    <button className="card itin" onClick={onClick}>
      <div className="itin-top">
        <div className="itin-times">
          <span className="t-big">{hm(it.dep)}</span>
          <span className="t-arrow" aria-hidden />
          <span className="t-big">{hm(it.arr)}</span>
        </div>
        <div className="itin-dur"><b>{mins(it.arr - it.dep)}</b> דק'</div>
      </div>
      <LegChips it={it} />
      {head && <div className="itin-car">{head}</div>}
      {it.legs.map((l) => l.car?.warn).filter(Boolean).map((w, i) => <div key={i} className="warn">{w}</div>)}
      <div className="itin-meta">
        {firstTransit?.onBus ? <span>להישאר באוטובוס עד {firstTransit.to.name}</span>
          : leaveIn > 0 ? <span>{leaveIn < 60 ? `יציאה בעוד ${leaveIn} דק'` : `יציאה ב-${hm(it.dep)}`}</span>
          : <span>לצאת עכשיו</span>}
        {it.transfers > 0 && <span>{it.transfers === 1 ? 'החלפה אחת' : `${it.transfers} החלפות`}</span>}
        {saving >= 2 && <span className="save">חוסך {saving} דק'</span>}
        {it.tags.filter((t) => !t.startsWith('לרדת')).map((t) => <span key={t} className="tag">{t}</span>)}
      </div>
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <div className="spinner" role="status"><i />{label && <span>{label}</span>}</div>;
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="empty"><b>{title}</b>{children && <p>{children}</p>}</div>;
}

export function DelayBadge({ delay }: { delay?: number }) {
  if (delay === undefined) return null;
  const m = Math.round(delay / 60);
  if (Math.abs(m) <= 1) return <span className="live ontime"><i />בזמן</span>;
  if (m > 0) return <span className="live late"><i />מאחר {m} דק'</span>;
  return <span className="live early"><i />מקדים {-m} דק'</span>;
}
