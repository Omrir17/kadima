import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusCandidate, Itinerary, Mode, Place, PlanRequest, PlanResponse, StopRef } from '../engine/model';
import type { LatLon } from '../engine/geo';
import { api } from '../api';
import { addRecent, updateSaved, useSaved } from '../store';
import { hm } from '../engine/time';
import { distM } from '../engine/geo';
import type { Scene } from './MapView';
import type { PickerOpts } from './PlacePicker';
import { ME_NAME } from './PlacePicker';
import { IconBus, IconDropoff, IconPickup, IconSwap, IconThumb, IconTrain } from './icons';
import { DelayBadge, Empty, ItinCard, LineBadge, Spinner, legColor, useNowSec } from './parts';

export interface PlanInit {
  mode: Mode;
  to?: Place;
  from?: Place;
}

interface Props {
  init: PlanInit;
  me: LatLon | null;
  openPicker: (o: PickerOpts) => void;
  setScene: (s: Scene) => void;
  onOpenTrip: (it: Itinerary, ctx: { mode: Mode; baseline?: Itinerary | null; req: PlanRequest }) => void;
  onModeChange?: (m: Mode) => void;
}

const MODES: { mode: Mode; label: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { mode: 'transit', label: 'תחבורה ציבורית', Icon: IconTrain },
  { mode: 'pickup', label: 'אוספים אותי', Icon: IconPickup },
  { mode: 'dropoff', label: 'מקפיצים אותי', Icon: IconDropoff },
  { mode: 'ride', label: 'אני בטרמפ', Icon: IconThumb },
  { mode: 'onbus', label: 'אני באוטובוס', Icon: IconBus },
];

const LAMBDAS = [
  { v: 0.1, label: 'הזמן שלי קודם' },
  { v: 0.35, label: 'מאוזן' },
  { v: 0.8, label: 'לחסוך לנהג' },
];

type TimeKind = 'now' | 'depart' | 'arrive';

export default function Plan({ init, me, openPicker, setScene, onOpenTrip, onModeChange }: Props) {
  const saved = useSaved();
  const st = saved.settings;
  const [mode, setMode] = useState<Mode>(init.mode);
  const [from, setFrom] = useState<Place | null>(init.from ?? null);
  const [to, setTo] = useState<Place | undefined>(init.to ?? (init.mode !== 'transit' && init.mode !== 'dropoff' ? saved.home : undefined));
  const [driver, setDriver] = useState<Place | null>(null);
  const [maxDrive, setMaxDrive] = useState(st.driveMin);
  const [lambda, setLambda] = useState(st.lambda);
  const [rideDest, setRideDest] = useState<Place | undefined>();
  const [detour, setDetour] = useState(st.detourMin);
  const [waze, setWaze] = useState('');
  const [timeKind, setTimeKind] = useState<TimeKind>('now');
  const [timeMs, setTimeMs] = useState(() => roundTo5(Date.now() + 10 * 60e3));
  // on-bus
  const [busLine, setBusLine] = useState('');
  const [busCands, setBusCands] = useState<BusCandidate[] | null>(null);
  const [busSel, setBusSel] = useState<BusCandidate | null>(null);
  const [busStops, setBusStops] = useState<StopRef[] | null>(null);
  const [nextPos, setNextPos] = useState<number | null>(null);
  const [busBusy, setBusBusy] = useState(false);

  const [resp, setResp] = useState<PlanResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const now = useNowSec(resp?.date);

  // Lock "my location" for planning: GPS jitters every few seconds, which would re-run the search.
  // Only move the anchor when the user has really moved (~200 m).
  const [anchor, setAnchor] = useState<LatLon | null>(me);
  useEffect(() => {
    if (!me) return;
    if (!anchor || distM(anchor[0], anchor[1], me[0], me[1]) > 200) setAnchor(me);
  }, [me]);
  const meP: Place | null = useMemo(() => (anchor ? { name: ME_NAME, lat: anchor[0], lon: anchor[1] } : null), [anchor]);
  const fromP = from ?? meP;
  const destP = to;
  const driverP = mode === 'pickup' ? (driver ?? saved.home ?? to ?? null) : mode === 'dropoff' ? (driver ?? fromP) : null;

  useEffect(() => {
    onModeChange?.(mode);
    document.querySelector('.mode.on')?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [mode]);

  // ------- build the request
  const req: PlanRequest | null = useMemo(() => {
    if (!destP) return null;
    const base = { prefs: st.prefs, to: destP, time: timeKind === 'now' ? undefined : timeMs, trafficKey: st.tomtomKey || undefined };
    switch (mode) {
      case 'transit':
        return fromP ? { ...base, mode, from: fromP, arriveBy: timeKind === 'arrive' } : null;
      case 'pickup':
        return fromP && driverP ? { ...base, mode, from: fromP, driver: driverP, maxDriveMin: maxDrive, lambda } : null;
      case 'dropoff':
        return driverP ? { ...base, mode, from: driverP, driver: driverP, maxDriveMin: maxDrive, lambda } : null;
      case 'ride': {
        const wz = Number(waze);
        return fromP && rideDest ? { ...base, time: undefined, mode, from: fromP, rideDest, detourMin: detour, wazeMin: wz > 0 ? wz : undefined } : null;
      }
      case 'onbus':
        return busSel ? {
          ...base, time: undefined, mode, from: meP ?? undefined,
          bus: { date: busSel.date, pattern: busSel.pattern, trip: busSel.trip, nextPos: nextPos ?? busSel.nextPos, delay: busSel.delay },
        } : null;
    }
  }, [mode, fromP?.lat, fromP?.lon, destP, driverP?.lat, driverP?.lon, maxDrive, lambda, rideDest, detour, waze, timeKind, timeMs, busSel, nextPos, st.prefs,
    // me only matters at ~100m resolution
    meP]);

  const reqKey = req ? JSON.stringify({ ...req, from: req.from && [req.from.lat.toFixed(3), req.from.lon.toFixed(3)] }) : '';

  useEffect(() => {
    if (!req) { setResp(null); return; }
    const g = ++gen.current;
    setBusy(true);
    setError(null);
    const t = setTimeout(() => {
      api.plan(req).then((r) => {
        if (g !== gen.current) return;
        setResp(r);
        setBusy(false);
      }).catch((e) => {
        if (g !== gen.current) return;
        setError(e.message);
        setBusy(false);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [reqKey]);

  // ------- map scene: draw best result
  useEffect(() => {
    const pins: Scene['pins'] = [];
    const fit: LatLon[] = [];
    if (fromP && mode !== 'dropoff') { pins.push({ lat: fromP.lat, lon: fromP.lon, kind: 'start' }); fit.push([fromP.lat, fromP.lon]); }
    if (destP) { pins.push({ lat: destP.lat, lon: destP.lon, kind: 'end' }); fit.push([destP.lat, destP.lon]); }
    if (driverP && (mode === 'pickup' || mode === 'dropoff')) { pins.push({ lat: driverP.lat, lon: driverP.lon, kind: 'car', label: 'נהג' }); fit.push([driverP.lat, driverP.lon]); }
    if (rideDest && mode === 'ride') { pins.push({ lat: rideDest.lat, lon: rideDest.lon, kind: 'pin', label: 'יעד הנהג' }); fit.push([rideDest.lat, rideDest.lon]); }
    const best = resp?.itineraries[0];
    if (!best) { setScene({ pins, fit, key: 'plan:' + fit.join() }); return; }
    let alive = true;
    api.legGeometry(best.legs).then((geo) => {
      if (!alive) return;
      const lines = best.legs.map((l, i) => ({ coords: geo[i], color: legColor(l), dash: l.kind === 'walk', width: l.kind === 'walk' ? 4 : 6 }));
      const pts = best.legs.filter((l) => l.kind !== 'walk').flatMap((l) => [l.from, l.to]).map((p) => ({ lat: p.lat, lon: p.lon, color: '#15202b' }));
      setScene({ lines, pins, points: pts, fit: [...fit, ...geo.flat()], key: 'plan:' + best.id });
    }).catch(() => {});
    return () => { alive = false; };
  }, [resp, mode, destP, rideDest, driverP?.lat]);

  // ------- on-bus: find candidates
  useEffect(() => {
    if (mode !== 'onbus') return;
    const q = busLine.trim();
    setBusSel(null);
    setBusStops(null);
    setNextPos(null);
    if (!q) { setBusCands(null); return; }
    let alive = true;
    setBusBusy(true);
    const t = setTimeout(() => {
      api.findBuses(q, anchor).then((c) => {
        if (!alive) return;
        setBusCands(c);
        setBusBusy(false);
        if (c.length === 1 || (c[0] && c[0].distM < 150 && (!c[1] || c[1].distM > 400))) choose(c[0]);
      }).catch(() => { setBusCands([]); setBusBusy(false); });
    }, 400);
    return () => { alive = false; clearTimeout(t); };
  }, [busLine, mode]);

  function choose(c: BusCandidate) {
    setBusSel(c);
    setNextPos(null);
    api.busStops(c.date, c.pattern, c.trip).then(setBusStops).catch(() => {});
  }

  const pickTo = (title = 'לאן?') => openPicker({ title, onPick: (p) => { setTo(p); addRecent(p); } });

  return (
    <div className="plan">
      <div className="modes" role="tablist">
        {MODES.map(({ mode: m, label, Icon }) => (
          <button key={m} role="tab" aria-selected={m === mode} className={'mode' + (m === mode ? ' on' : '') + (m !== 'transit' ? ' flex' : '')}
            onClick={() => { setMode(m); setResp(null); }}>
            <Icon size={17} />{label}
          </button>
        ))}
      </div>

      <div className="form">
        {mode === 'transit' && (
          <div className="ft">
            <div className="ft-fields">
              <Field label="מ" value={fromP?.name} placeholder="נקודת מוצא" onClick={() => openPicker({ title: 'מאיפה?', allowCurrent: true, onPick: (p) => setFrom(p.name === ME_NAME ? null : p) })} />
              <Field label="ל" value={destP?.name} placeholder="לאן?" onClick={() => pickTo()} />
            </div>
            <button className="icon-btn swap" aria-label="החלפת מוצא ויעד" onClick={() => { const f = fromP; setFrom(destP ?? null); setTo(f ?? undefined); }}><IconSwap /></button>
          </div>
        )}

        {mode === 'pickup' && (
          <>
            <p className="hint">מישהו מוכן לבוא לאסוף? נחשב באיזו תחנה הכי כדאי לרדת כדי שיאסוף אותך משם.</p>
            <Field label="יוצאים מ" value={fromP?.name} placeholder="המיקום שלי" onClick={() => openPicker({ title: 'מאיפה יוצאים?', allowCurrent: true, onPick: (p) => setFrom(p.name === ME_NAME ? null : p) })} />
            <Field label="הנהג יוצא מ" value={driverP?.name} placeholder="בית" onClick={() => openPicker({ title: 'מאיפה הנהג יוצא?', allowCurrent: true, onPick: (p) => setDriver(p) })} />
            <Field label="ונוסעים ל" value={destP?.name} placeholder="לאן?" onClick={() => pickTo('לאן הנהג לוקח אותך?')} />
            <DriveControls maxDrive={maxDrive} setMaxDrive={setMaxDrive} lambda={lambda} setLambda={setLambda} />
          </>
        )}

        {mode === 'dropoff' && (
          <>
            <p className="hint">מישהו יכול להקפיץ בתחילת הדרך? נמצא את התחנה שהכי מקצרת את הנסיעה.</p>
            <Field label="יוצאים מ" value={driverP?.name} placeholder="המיקום שלי" onClick={() => openPicker({ title: 'מאיפה יוצאים?', allowCurrent: true, onPick: (p) => setDriver(p.name === ME_NAME ? null : p) })} />
            <Field label="היעד שלי" value={destP?.name} placeholder="לאן?" onClick={() => pickTo()} />
            <DriveControls maxDrive={maxDrive} setMaxDrive={setMaxDrive} lambda={lambda} setLambda={setLambda} />
          </>
        )}

        {mode === 'ride' && (
          <>
            <p className="hint">נוסעים עם מישהו שממשיך למקום אחר? נמצא בדיוק איפה לרדת ואיך להמשיך משם.</p>
            <Field label="הנהג נוסע ל" value={rideDest?.name} placeholder="יעד הנהג" onClick={() => openPicker({ title: 'לאן הנהג נוסע?', onPick: (p) => { setRideDest(p); addRecent(p); } })} />
            <Field label="היעד שלי" value={destP?.name} placeholder="לאן?" onClick={() => pickTo()} />
            <label className="slider">
              <span>הנהג מוכן לעקוף עד <b>{detour}</b> דק'</span>
              <input type="range" min={0} max={15} value={detour} onChange={(e) => setDetour(+e.target.value)} />
            </label>
            <label className="waze">
              <span>זמן הנסיעה לפי Waze (לא חובה)</span>
              <span className="waze-in"><input inputMode="numeric" placeholder="—" value={waze} onChange={(e) => setWaze(e.target.value.replace(/\D/g, ''))} /> דק' עד היעד של הנהג</span>
            </label>
          </>
        )}

        {mode === 'onbus' && (
          <>
            <p className="hint">באיזה קו נוסעים? נמצא באיזו תחנה הכי כדאי לרדת ומה עושים אחר כך.</p>
            <label className="busline">
              <span>מספר הקו</span>
              <input inputMode="numeric" placeholder="למשל 66" value={busLine} onChange={(e) => setBusLine(e.target.value.trim())} />
            </label>
            {busBusy && <Spinner label="מחפש את האוטובוס שלך" />}
            {!busBusy && busCands && busCands.length === 0 && <p className="muted">לא מצאנו את קו {busLine} לידך עכשיו. בדוק את המספר, או שהשירות לא פעיל כרגע.</p>}
            {busCands && busCands.length > 0 && !busSel && (
              <div className="cands">
                <small className="muted">באיזה כיוון?</small>
                {busCands.map((c) => (
                  <button key={c.pattern + ':' + c.trip} className="cand" onClick={() => choose(c)}>
                    <LineBadge line={c.line} color={c.color} size="s" />
                    <span className="cand-txt"><b>ל{c.headsign}</b><small>{c.agencyName}{me ? `, התחנה הבאה: ${c.nextStopName}` : ''}</small></span>
                    {c.live && <DelayBadge delay={c.delay} />}
                  </button>
                ))}
              </div>
            )}
            {busSel && (
              <div className="bus-sel">
                <div className="bus-sel-top">
                  <span>קו <b>{busSel.line}</b> ל{busSel.headsign}</span>
                  {busSel.live ? <DelayBadge delay={busSel.delay} /> : <small className="muted">לפי לוח זמנים</small>}
                  <button className="link" onClick={() => setBusSel(null)}>שינוי</button>
                </div>
                {busStops && (
                  <label className="nextstop">
                    <span>התחנה הבאה</span>
                    <select value={nextPos ?? busSel.nextPos} onChange={(e) => setNextPos(+e.target.value)}>
                      {busStops.map((s, i) => i > 0 && <option key={i} value={i}>{s.name} ({hm(s.t + busSel.delay)})</option>)}
                    </select>
                  </label>
                )}
                <Field label="היעד שלי" value={destP?.name} placeholder="לאן?" onClick={() => pickTo()} />
              </div>
            )}
          </>
        )}

        {(mode === 'transit' || mode === 'pickup' || mode === 'dropoff') && (
          <div className="when">
            <div className="seg-ctl">
              {(['now', 'depart', ...(mode === 'transit' ? ['arrive'] : [])] as TimeKind[]).map((k) => (
                <button key={k} className={timeKind === k ? 'on' : ''} onClick={() => setTimeKind(k)}>
                  {k === 'now' ? 'עכשיו' : k === 'depart' ? 'יציאה ב' : 'הגעה עד'}
                </button>
              ))}
            </div>
            {timeKind !== 'now' && (
              <input type="datetime-local" className="dt" value={toLocalInput(timeMs)} onChange={(e) => e.target.value && setTimeMs(new Date(e.target.value).getTime())} />
            )}
          </div>
        )}
      </div>

      {!fromP && mode !== 'onbus' && mode !== 'dropoff' && <p className="muted pad">צריך לאשר גישה למיקום, או לבחור נקודת מוצא.</p>}
      {busy && !resp && <Spinner label={mode === 'pickup' || mode === 'dropoff' ? 'בודק זמני נסיעה ברכב…' : 'מחשב מסלולים…'} />}
      {busy && resp && <p className="muted small refreshing">מעדכן…</p>}
      {error && <Empty title="משהו השתבש">{error}</Empty>}
      {resp && (
        <div className="results">
          {resp.baseline && (
            <div className="baseline">בלי נהג: הגעה ב-<b>{hm(resp.baseline.arr)}</b> בתחבורה ציבורית בלבד</div>
          )}
          {resp.itineraries.length === 0 && <Empty title="לא מצאנו מסלול">{resp.note || 'נסו שעה אחרת או נקודת מוצא אחרת.'}</Empty>}
          {resp.itineraries.map((it) => (
            <ItinCard key={it.id} it={it} now={now} baseline={resp.baseline} onClick={() => req && onOpenTrip(it, { mode, baseline: resp.baseline, req })} />
          ))}
          {resp.itineraries.length > 0 && resp.note && <p className="muted small">{resp.note}</p>}
          {resp.approx && <p className="muted small">זמני הנסיעה ברכב משוערים כי שירות המפות לא ענה.</p>}
          {resp.traffic === 'on' && resp.itineraries.some((i) => i.legs.some((l) => l.car)) && <p className="traffic-ok">זמני הנסיעה ברכב כוללים פקקים</p>}
          {resp.traffic && resp.traffic !== 'on' && resp.traffic !== 'off' && <p className="muted small">פקקים לא נלקחו בחשבון: {resp.traffic}</p>}
        </div>
      )}
      {destP && mode === 'transit' && !isSaved(saved, destP) && destP.name !== ME_NAME && (
        <button className="link save-fav" onClick={() => updateSaved((s) => ({ ...s, favorites: [...s.favorites, destP] }))}>שמירת {destP.name} במועדפים</button>
      )}
    </div>
  );
}

function isSaved(s: ReturnType<typeof useSaved>, p: Place) {
  const same = (a?: Place) => !!a && Math.abs(a.lat - p.lat) < 1e-5 && Math.abs(a.lon - p.lon) < 1e-5;
  return same(s.home) || same(s.work) || s.favorites.some(same);
}

function Field({ label, value, placeholder, onClick }: { label: string; value?: string; placeholder: string; onClick: () => void }) {
  return (
    <button className="field" onClick={onClick}>
      <span className="field-l">{label}</span>
      <span className={'field-v' + (value ? '' : ' ph')}>{value || placeholder}</span>
    </button>
  );
}

function DriveControls({ maxDrive, setMaxDrive, lambda, setLambda }: { maxDrive: number; setMaxDrive: (n: number) => void; lambda: number; setLambda: (n: number) => void }) {
  return (
    <>
      <label className="slider">
        <span>הנהג מוכן לנסוע עד <b>{maxDrive}</b> דק' לכל כיוון</span>
        <input type="range" min={3} max={30} value={maxDrive} onChange={(e) => setMaxDrive(+e.target.value)} />
      </label>
      <div className="seg-ctl small">
        {LAMBDAS.map((l) => (
          <button key={l.v} className={Math.abs(lambda - l.v) < 0.01 ? 'on' : ''} onClick={() => setLambda(l.v)}>{l.label}</button>
        ))}
      </div>
    </>
  );
}

function roundTo5(ms: number) {
  return Math.round(ms / 300000) * 300000;
}

function toLocalInput(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
