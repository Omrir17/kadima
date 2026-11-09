import { useEffect, useRef, useState } from 'react';
import type { Itinerary, Leg, Mode, Place, VehicleView } from '../engine/model';
import type { LatLon } from '../engine/geo';
import { distM } from '../engine/geo';
import { api } from '../api';
import { durText, hm, mins } from '../engine/time';
import type { Scene } from './MapView';
import { IconCar, IconNav, IconShare, IconWalk, IconWhatsapp } from './icons';
import { DelayBadge, LineBadge, LiveIcon, RIDE, legColor, useNowSec } from './parts';

interface Props {
  it: Itinerary;
  mode: Mode;
  baseline?: Itinerary | null;
  setScene: (s: Scene) => void;
  setVehicles: (v: VehicleView[]) => void;
  openStop: (p: Place) => void;
  me: LatLon | null;
  setFollow: (f: boolean) => void;
}

interface Live { delay: number; v: VehicleView; pos: number; stopsAway?: number }

/** Delay already baked into a planned leg's times (live plans, or the bus I'm on). */
function bakedDelay(l: Leg) {
  return l.live || l.onBus ? l.delay ?? 0 : 0;
}

export default function Trip({ it, mode, baseline, setScene, setVehicles, openStop, me, setFollow }: Props) {
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
        api.liveForLeg(it.date, l.trip, l.gtfsRoute!, l.onBus ? undefined : l.board).then((r) => alive && setLive((x) => ({ ...x, [i]: r }))).catch(() => {});
      });
    };
    poll();
    const iv = setInterval(poll, 10000);
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
    setScene({ lines, points, pins, fit: geo.flat(), key: 'trip:' + it.id });
  }, [geo]);

  useEffect(() => {
    setVehicles(Object.values(live).filter((x): x is Live => !!x).map((x) => x.v));
  }, [live]);

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

      <Tracker it={it} live={live} me={me} now={now} setFollow={setFollow} />

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
          <div className="step-line"><span>{l.from.name === l.to.name ? 'מעבר לתחנה הסמוכה' : `הליכה אל ${l.to.name}`}</span><span className="t">{hm(l.dep)}</span></div>
          <small className="muted">{durText(l.arr - l.dep)}, {l.dist} מ'</small>
        </div>
      </li>
    );
  }
  if (l.kind === 'car') {
    const c = l.car!;
    const text = c.role === 'pickup' ? `איסוף בתחנה ${l.from.name}` : c.role === 'dropoff' ? `נסיעה ברכב אל ${l.to.name}` : (next ? `נשארים ברכב עד ${l.to.name}` : `נשארים ברכב עד היעד`);
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
  const baked = bakedDelay(l);
  const delay = live?.delay ?? (l.live || l.onBus ? l.delay : undefined);
  const schedDep = l.dep - (l.onBus ? 0 : baked);
  const upcoming = schedDep + (delay ?? 0) > now - 60;
  const depLive = l.onBus ? l.dep : schedDep + (delay ?? 0);
  const isLive = delay !== undefined;
  return (
    <li className="step transit" style={{ ['--c' as any]: color }}>
      <span className="dot" />
      <div className="step-body">
        <button className="step-line stop-link" onClick={() => l.from.stop !== undefined && openStop(l.from)}>
          <b>{l.onBus ? 'ממשיכים באוטובוס' : l.from.name}</b>
          <span className={'t' + (isLive && !l.onBus ? ' t-live' : '')}>{isLive && !l.onBus && <LiveIcon />}{hm(depLive)}{delay !== undefined && Math.abs(delay) > 60 && !l.onBus && <s>{hm(schedDep)}</s>}</span>
        </button>
        <div className="ride-card">
          <LineBadge line={l.line} color={l.color} rtype={l.rtype} size="m" />
          <div className="ride-txt">
            <b>ל{l.headsign}</b>
            <small>{l.agencyName}{l.from.code && !l.onBus ? `, תחנה ${l.from.code}` : ''}</small>
          </div>
          {delay !== undefined ? <DelayBadge delay={delay} /> : upcoming ? <small className="muted">לפי לוח זמנים</small> : null}
        </div>
        {upcoming && !l.onBus && depLive - now < 3600 && (
          <small className={'countdown' + (isLive ? ' is-live' : '')}>
            {depLive - now > 60 ? `יוצא בעוד ${mins(depLive - now)} דק'` : 'יוצא עכשיו'}
            {live?.stopsAway !== undefined && `, האוטובוס ${live.stopsAway === 0 ? 'בתחנה' : live.stopsAway === 1 ? 'תחנה אחת לפני' : `${live.stopsAway} תחנות לפני`}`}
          </small>
        )}
        {mid.length > 0 && (
          <button className="link stops-toggle" onClick={toggle}>{open ? 'הסתרת תחנות' : `${mid.length + 1} תחנות, ${durText(l.arr - l.dep)}`}</button>
        )}
        {open && (
          <ul className="mid-stops">
            {mid.map((s) => <li key={s.stop}><span>{s.name}</span><span className="t">{hm(s.t - baked + (delay ?? 0))}</span></li>)}
          </ul>
        )}
        <div className="step-line alight">
          <b>{l.onBus ? `לרדת בתחנה ${l.to.name}` : `ירידה בתחנה ${l.to.name}`}</b>
          <span className={'t' + (isLive ? ' t-live' : '')}>{hm(l.arr - baked + (delay ?? 0))}</span>
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
    msg = `היי! אפשר לאסוף אותי בתחנה ${leg.from.name}${leg.from.code ? ` (תחנה ${leg.from.code})` : ''} ב-${hm(leg.dep - 60)}?\nכדי להגיע בזמן צריך לצאת ב-${hm(c.driverLeaves!)} (בערך ${mins(c.driveSec)} דק' נסיעה).\nניווט: ${wazeLink(leg.from)}`;
  } else if (c.role === 'dropoff') {
    point = leg.to;
    title = it.legs.length === 1 ? `יוצאים ב-${hm(leg.dep)}` : `יוצאים ב-${hm(leg.dep)} אל ${leg.to.name}`;
    msg = it.legs.length === 1
      ? `תוכל/י לקחת אותי אל ${leg.to.name}? יוצאים ב-${hm(leg.dep)}.\nניווט: ${wazeLink(leg.to)}`
      : `תוכל/י להקפיץ אותי אל ${leg.to.name}? יוצאים ב-${hm(leg.dep)} כדי להספיק את ${it.legs.find((l) => l.kind === 'transit')?.line ?? 'ההמשך'} ב-${hm(it.legs.find((l) => l.kind === 'transit')?.dep ?? leg.arr)}.\nניווט: ${wazeLink(leg.to)}`;
  } else {
    point = leg.to;
    title = it.legs.length === 1 ? 'לבקש מהנהג להוריד אותך ביעד' : `לבקש לרדת: ${leg.to.name}`;
    msg = `אפשר להוריד אותי כאן: ${leg.to.name}? (${mins(c.driveSec)} דק' מכאן${c.detourSec ? `, עיקוף של בערך ${mins(c.detourSec)} דק'` : ''})\nניווט: ${wazeLink(leg.to)}`;
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

// ---------------------------------------------------------------- live trip tracking

type Status = { title: string; sub?: string; urgent?: boolean; alertKey?: string; alertText?: string };

function legStatus(it: Itinerary, live: Record<number, Live | null>, me: LatLon | null, now: number): Status {
  const legs = it.legs;
  const delayOf = (i: number) => {
    const l = legs[i];
    return live[i]?.delay ?? (l.live || l.onBus ? l.delay ?? 0 : 0);
  };
  // 1) am I on one of the buses? (GPS near its stops while it's running)
  if (me) {
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      if (l.kind !== 'transit') continue;
      const baked = bakedDelay(l);
      const delay = delayOf(i);
      const dep = l.onBus ? l.dep : l.dep - baked + delay;
      const arr = l.arr - baked + delay;
      if (now < dep - 60 || now > arr + 10 * 60) continue;
      const st = l.stops!;
      let k = 0, best = Infinity;
      st.forEach((s, j) => { const d = distM(me[0], me[1], s.lat, s.lon); if (d < best) { best = d; k = j; } });
      if (best > 350) continue;
      if (k === 0 && !l.onBus && now < dep + 30) break; // still waiting at the first stop
      const left = st.length - 1 - k;
      const next = legs.slice(i + 1).find((x) => x.kind === 'transit');
      if (left <= 0) return { title: `יורדים כאן: ${l.to.name}`, sub: next ? `ההמשך: קו ${next.line}` : undefined, urgent: true, alertKey: 'off' + i, alertText: `רדו עכשיו: ${l.to.name}` };
      if (left === 1) return { title: 'רדו בתחנה הבאה!', sub: l.to.name, urgent: true, alertKey: 'next' + i, alertText: `רדו בתחנה הבאה: ${l.to.name}` };
      return { title: `עוד ${left} תחנות`, sub: `לרדת בתחנה ${l.to.name}, בערך ב-${hm(arr)}` };
    }
  }
  // 2) otherwise: the next thing to do, by time
  const nextIdx = legs.findIndex((l, i) => l.arr - bakedDelay(l) + delayOf(i) > now - 30);
  if (nextIdx < 0) return { title: 'הגעת ליעד', sub: legs[legs.length - 1].to.name };
  const l = legs[nextIdx];
  if (l.kind === 'walk') {
    const dist = me ? Math.round(distM(me[0], me[1], l.to.lat, l.to.lon) * 1.3) : l.dist ?? 0;
    const ti = legs.findIndex((x, i) => i > nextIdx && x.kind === 'transit');
    const nextT = ti >= 0 ? legs[ti] : undefined;
    const need = nextT ? nextT.dep - bakedDelay(nextT) + delayOf(ti) : l.arr;
    const late = me ? now + dist / 1.25 > need : false;
    const lineTxt = nextT ? `, קו ${nextT.line} יוצא ב-${hm(need)}` : '';
    return { title: `הליכה אל ${l.to.name}`, sub: `${dist} מ'${lineTxt}`, urgent: late };
  }
  if (l.kind === 'transit') {
    const lv = live[nextIdx];
    const dep = l.dep - bakedDelay(l) + delayOf(nextIdx);
    const m = Math.max(0, Math.round((dep - now) / 60));
    const away = lv?.stopsAway !== undefined ? (lv.stopsAway === 0 ? ', האוטובוס בתחנה' : `, האוטובוס ${lv.stopsAway} תחנות מכאן`) : '';
    return {
      title: m > 0 ? `קו ${l.line} מגיע בעוד ${m} דק'` : `קו ${l.line} מגיע עכשיו`,
      sub: `בתחנה ${l.from.name}${away}`,
      urgent: m <= 2,
      alertKey: m <= 2 ? 'board' + nextIdx : undefined,
      alertText: `קו ${l.line} מגיע לתחנה ${l.from.name}`,
    };
  }
  const c = l.car!;
  if (c.role === 'pickup') return { title: `האיסוף בתחנה ${l.from.name}`, sub: `ב-${hm(l.dep - 60)}` };
  if (c.role === 'dropoff') return { title: `נוסעים ברכב אל ${l.to.name}`, sub: `יציאה ב-${hm(l.dep)}` };
  return { title: `לרדת מהרכב: ${l.to.name}`, sub: `בערך ב-${hm(l.arr)}` };
}

function Tracker({ it, live, me, now, setFollow }: { it: Itinerary; live: Record<number, Live | null>; me: LatLon | null; now: number; setFollow: (f: boolean) => void }) {
  const [on, setOn] = useState(false);
  const [, tick] = useState(0);
  const alerted = useRef(new Set<string>());
  const audio = useRef<AudioContext | null>(null);
  const lock = useRef<any>(null);

  // re-evaluate every 5 s while tracking (GPS updates also re-render)
  useEffect(() => {
    if (!on) return;
    const i = setInterval(() => tick((x) => x + 1), 5000);
    return () => clearInterval(i);
  }, [on]);

  // keep the screen awake while tracking
  useEffect(() => {
    if (!on) return;
    const req = async () => { try { lock.current = await (navigator as any).wakeLock?.request('screen'); } catch { /* not supported */ } };
    req();
    const vis = () => { if (document.visibilityState === 'visible') req(); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); try { lock.current?.release(); } catch { /* ignore */ } };
  }, [on]);

  useEffect(() => () => setFollow(false), []);

  const status = on ? legStatus(it, live, me, now) : null;

  useEffect(() => {
    if (!status?.alertKey || alerted.current.has(status.alertKey)) return;
    alerted.current.add(status.alertKey);
    notify(status.alertText || status.title);
  }, [status?.alertKey]);

  function notify(text: string) {
    try { navigator.vibrate?.([300, 150, 300]); } catch { /* iOS has no vibration API */ }
    try {
      const ctx = audio.current;
      if (ctx) {
        [0, 0.35].forEach((t) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.frequency.value = 880;
          g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
          g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.25);
          o.connect(g).connect(ctx.destination);
          o.start(ctx.currentTime + t);
          o.stop(ctx.currentTime + t + 0.3);
        });
      }
    } catch { /* ignore */ }
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker?.ready.then((r) => r.showNotification('קדימה', { body: text, tag: 'kadima-trip' })).catch(() => {});
      }
    } catch { /* ignore */ }
  }

  const start = () => {
    // sound and notifications must be unlocked by a tap
    try {
      audio.current = audio.current ?? new (window.AudioContext || (window as any).webkitAudioContext)();
      audio.current.resume();
    } catch { /* ignore */ }
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    alerted.current.clear();
    setOn(true);
    setFollow(true);
  };
  const stop = () => { setOn(false); setFollow(false); };

  if (!on) {
    return (
      <button className="btn track-btn" onClick={start}>
        <IconNav size={18} />מעקב חי בדרך
      </button>
    );
  }
  return (
    <div className={'tracker' + (status?.urgent ? ' urgent' : '')} role="status" aria-live="assertive">
      <div className="tracker-main">
        <b>{status?.title}</b>
        {status?.sub && <span>{status.sub}</span>}
        {!me && <small>מחכה למיקום GPS…</small>}
      </div>
      <button className="link" onClick={stop}>הפסקה</button>
    </div>
  );
}
