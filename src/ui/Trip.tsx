import { useEffect, useState } from 'react';
import type { Itinerary, Leg, Mode, Place, VehicleView } from '../engine/model';
import { api } from '../api';
import { durText, hm, mins } from '../engine/time';
import type { Scene } from './MapView';
import { IconCar, IconNav, IconShare, IconWalk, IconWhatsapp } from './icons';
import { DelayBadge, LineBadge, RIDE, legColor, useNowSec } from './parts';

interface Props {
  it: Itinerary;
  mode: Mode;
  baseline?: Itinerary | null;
  setScene: (s: Scene) => void;
  openStop: (p: Place) => void;
}

interface Live { delay: number; v: VehicleView; pos: number }

export default function Trip({ it, mode, baseline, setScene, openStop }: Props) {
  const now = useNowSec(it.date);
  const [geo, setGeo] = useState<[number, number][][] | null>(null);
  const [live, setLive] = useState<Record<number, Live | null>>({});
  const [open, setOpen] = useState<Record<number, boolean>>({});

  useEffect(() => {
    api.legGeometry(it.legs).then(setGeo).catch(() => setGeo(it.legs.map((l) => [[l.from.lat, l.from.lon], [l.to.lat, l.to.lon]])));
  }, [it.id]);

  // live polling for upcoming transit legs
  useEffect(() => {
    let alive = true;
    const poll = () => {
      const nowSec = now;
      it.legs.forEach((l, i) => {
        if (l.kind !== 'transit' || l.trip === undefined || l.arr < nowSec - 120) return;
        if (l.dep > nowSec + 90 * 60) return;
        api.liveForLeg(it.date, l.trip, l.gtfsRoute!).then((r) => alive && setLive((x) => ({ ...x, [i]: r }))).catch(() => {});
      });
    };
    poll();
    const iv = setInterval(poll, 20000);
    return () => { alive = false; clearInterval(iv); };
  }, [it.id]);

  useEffect(() => {
    if (!geo) return;
    const lines = it.legs.map((l, i) => ({ coords: geo[i], color: legColor(l), dash: l.kind === 'walk', width: l.kind === 'walk' ? 4 : 6 }));
    const points = it.legs.flatMap((l) => (l.kind === 'transit' ? l.stops!.map((s, k) => ({ lat: s.lat, lon: s.lon, color: l.color, small: k > 0 && k < l.stops!.length - 1 })) : []));
    const first = it.legs[0], last = it.legs[it.legs.length - 1];
    const pins: Scene['pins'] = [{ lat: first.from.lat, lon: first.from.lon, kind: 'start' }, { lat: last.to.lat, lon: last.to.lon, kind: 'end' }];
    for (const l of it.legs) {
      if (l.kind === 'car' && l.car?.role === 'pickup') pins.push({ lat: l.from.lat, lon: l.from.lon, kind: 'car', label: 'איסוף' });
      if (l.kind === 'car' && l.car?.role !== 'pickup' && it.legs.length > 1) pins.push({ lat: l.to.lat, lon: l.to.lon, kind: 'car', label: 'ירידה' });
    }
    const vehicles = Object.values(live).filter(Boolean).map((x) => ({ lat: x!.v.lat, lon: x!.v.lon, color: x!.v.color, label: x!.v.line, late: x!.delay > 180 }));
    setScene({ lines, points, pins, vehicles, fit: geo.flat(), key: 'trip:' + it.id });
  }, [geo, live]);

  const saving = baseline ? Math.round((baseline.arr - it.arr) / 60) : 0;

  return (
    <div className="trip">
      <div className="trip-head">
        <div className="itin-times">
          <span className="t-big">{hm(it.dep)}</span>
          <span className="t-arrow" aria-hidden />
          <span className="t-big">{hm(it.arr)}</span>
        </div>
        <div className="itin-dur"><b>{mins(it.arr - it.dep)}</b> דק'</div>
      </div>
      {saving >= 2 && <p className="save-line">מגיעים {saving} דק' לפני המסלול בתחבורה ציבורית בלבד ({hm(baseline!.arr)})</p>}

      {it.legs.map((l, i) => l.kind === 'car' && <DriverPanel key={'d' + i} leg={l} it={it} mode={mode} />)}

      <ol className="steps">
        {it.legs.map((l, i) => (
          <Step key={i} leg={l} next={it.legs[i + 1]} live={live[i]} now={now} open={!!open[i]} toggle={() => setOpen((o) => ({ ...o, [i]: !o[i] }))} openStop={openStop} />
        ))}
        <li className="step end">
          <span className="dot" />
          <div className="step-body">
            <div className="step-line"><b>{it.legs[it.legs.length - 1].to.name}</b><span className="t">{hm(it.arr)}</span></div>
            <small className="muted">הגעה</small>
          </div>
        </li>
      </ol>
    </div>
  );
}

function Step({ leg: l, next, live, now, open, toggle, openStop }: { leg: Leg; next?: Leg; live?: Live | null; now: number; open: boolean; toggle: () => void; openStop: (p: Place) => void }) {
  const color = legColor(l);
  if (l.kind === 'walk') {
    return (
      <li className="step walk" style={{ ['--c' as any]: color }}>
        <span className="dot"><IconWalk size={16} /></span>
        <div className="step-body">
          <div className="step-line"><span>{l.from.name === l.to.name ? 'מעבר לתחנה הסמוכה' : `הליכה ל${l.to.name}`}</span><span className="t">{hm(l.dep)}</span></div>
          <small className="muted">{durText(l.arr - l.dep)}, {l.dist} מ'</small>
        </div>
      </li>
    );
  }
  if (l.kind === 'car') {
    const c = l.car!;
    const text = c.role === 'pickup' ? `איסוף ב${l.from.name}` : c.role === 'dropoff' ? `נסיעה ברכב ל${l.to.name}` : (next ? `נשארים ברכב עד ${l.to.name}` : `נשארים ברכב עד היעד`);
    return (
      <li className="step car" style={{ ['--c' as any]: RIDE }}>
        <span className="dot"><IconCar size={16} /></span>
        <div className="step-body">
          <div className="step-line"><b>{text}</b><span className="t">{hm(l.dep)}</span></div>
          <small className="muted">
            {durText(c.driveSec)} ברכב
            {c.role === 'ride' && c.detourSec ? `, עיקוף של כ-${mins(c.detourSec)} דק' לנהג` : ''}
            {c.approx ? ' (הערכה)' : c.traffic ? ', כולל פקקים' : ''}
          </small>
          {c.warn && <small className="warn">{c.warn}</small>}
        </div>
      </li>
    );
  }
  const stops = l.stops!;
  const mid = stops.slice(1, -1);
  const delay = live?.delay ?? (l.onBus ? l.delay : undefined);
  const upcoming = l.dep > now - 60;
  const depLive = delay !== undefined && !l.onBus ? l.dep + delay : l.dep;
  return (
    <li className="step transit" style={{ ['--c' as any]: color }}>
      <span className="dot" />
      <div className="step-body">
        <button className="step-line stop-link" onClick={() => l.from.stop !== undefined && openStop(l.from)}>
          <b>{l.onBus ? 'ממשיכים באוטובוס' : l.from.name}</b>
          <span className="t">{hm(depLive)}{delay !== undefined && Math.abs(delay) > 60 && !l.onBus && <s>{hm(l.dep)}</s>}</span>
        </button>
        <div className="ride-card">
          <LineBadge line={l.line} color={l.color} rtype={l.rtype} size="m" />
          <div className="ride-txt">
            <b>ל{l.headsign}</b>
            <small>{l.agencyName}{l.from.code && !l.onBus ? `, תחנה ${l.from.code}` : ''}</small>
          </div>
          {delay !== undefined ? <DelayBadge delay={delay} /> : upcoming ? <small className="muted">לפי לוח זמנים</small> : null}
        </div>
        {upcoming && !l.onBus && depLive - now < 3600 && <small className="countdown">{depLive - now > 60 ? `יוצא בעוד ${mins(depLive - now)} דק'` : 'יוצא עכשיו'}</small>}
        {mid.length > 0 && (
          <button className="link stops-toggle" onClick={toggle}>{open ? 'הסתרת תחנות' : `${mid.length + 1} תחנות, ${durText(l.arr - l.dep)}`}</button>
        )}
        {open && (
          <ul className="mid-stops">
            {mid.map((s) => <li key={s.stop}><span>{s.name}</span><span className="t">{hm(s.t + (delay ?? 0))}</span></li>)}
          </ul>
        )}
        <div className="step-line alight">
          <b>{l.onBus ? `לרדת ב${l.to.name}` : `ירידה ב${l.to.name}`}</b>
          <span className="t">{hm(l.arr + (l.onBus ? 0 : delay ?? 0))}</span>
        </div>
      </div>
    </li>
  );
}

function wazeLink(p: { lat: number; lon: number }) {
  return `https://waze.com/ul?ll=${p.lat.toFixed(6)},${p.lon.toFixed(6)}&navigate=yes`;
}

function DriverPanel({ leg, it, mode }: { leg: Leg; it: Itinerary; mode: Mode }) {
  const c = leg.car!;
  let msg = '';
  let title = '';
  let point: Place = leg.from;
  if (c.role === 'pickup') {
    point = leg.from;
    title = `הנהג יוצא ב-${hm(c.driverLeaves!)}`;
    msg = `היי! אפשר לאסוף אותי ב${leg.from.name}${leg.from.code ? ` (תחנה ${leg.from.code})` : ''} ב-${hm(leg.dep - 60)}?\nכדי להגיע בזמן צריך לצאת ב-${hm(c.driverLeaves!)} (בערך ${mins(c.driveSec)} דק' נסיעה).\nניווט: ${wazeLink(leg.from)}`;
  } else if (c.role === 'dropoff') {
    point = leg.to;
    title = it.legs.length === 1 ? `יוצאים ב-${hm(leg.dep)}` : `יוצאים ב-${hm(leg.dep)} ל${leg.to.name}`;
    msg = it.legs.length === 1
      ? `תוכל/י לקחת אותי ל${leg.to.name}? יוצאים ב-${hm(leg.dep)}.\nניווט: ${wazeLink(leg.to)}`
      : `תוכל/י להקפיץ אותי ל${leg.to.name}? יוצאים ב-${hm(leg.dep)} כדי להספיק את ${it.legs.find((l) => l.kind === 'transit')?.line ?? 'ההמשך'} ב-${hm(it.legs.find((l) => l.kind === 'transit')?.dep ?? leg.arr)}.\nניווט: ${wazeLink(leg.to)}`;
  } else {
    point = leg.to;
    title = it.legs.length === 1 ? 'לבקש מהנהג להוריד אותך ביעד' : `לבקש לרדת ב${leg.to.name}`;
    msg = `אפשר להוריד אותי ב${leg.to.name}? (${mins(c.driveSec)} דק' מכאן${c.detourSec ? `, עיקוף של בערך ${mins(c.detourSec)} דק'` : ''})\nניווט: ${wazeLink(leg.to)}`;
  }
  const share = async () => {
    if (navigator.share) {
      try { await navigator.share({ text: msg }); } catch { /* cancelled */ }
    } else window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  };
  return (
    <div className="driver">
      <div className="driver-top">
        <span className="driver-ic"><IconCar size={20} /></span>
        <div>
          <b>{title}</b>
          {c.driverTotalSec ? <small>זמן נהיגה לנהג: {mins(c.driverTotalSec)} דק'{c.approx ? ' (הערכה)' : c.traffic ? ', כולל פקקים' : ''}</small>
            : c.detourSec ? <small>עיקוף לנהג: כ-{mins(c.detourSec)} דק'</small> : <small>בלי עיקוף לנהג</small>}
        </div>
      </div>
      {c.warn && <div className="warn">{c.warn}</div>}
      <div className="driver-actions">
        <a className="btn wa" href={`https://wa.me/?text=${encodeURIComponent(msg)}`} target="_blank" rel="noreferrer"><IconWhatsapp size={18} />שליחה לנהג</a>
        <a className="btn" href={wazeLink(point)} target="_blank" rel="noreferrer"><IconNav size={18} />Waze</a>
        <button className="btn icon-only" onClick={share} aria-label="שיתוף"><IconShare size={18} /></button>
      </div>
    </div>
  );
}
