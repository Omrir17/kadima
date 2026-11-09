import { useEffect, useState } from 'react';
import type { LineVariant, Place, VehicleView } from '../engine/model';
import type { LatLon } from '../engine/geo';
import { api } from '../api';
import { hm } from '../engine/time';
import { updateSaved, useSaved } from '../store';
import type { Scene } from './MapView';
import { IconStar } from './icons';
import { DelayBadge, Empty, LineBadge, Spinner, useNowSec } from './parts';

interface Props {
  initialQ?: string;
  initialRoute?: number; // GTFS route id to open directly (favourites, stop screen)
  setScene: (s: Scene) => void;
  setVehicles: (v: VehicleView[]) => void;
  openStop: (p: Place) => void;
  me?: LatLon | null;
}

type Detail = { date: string; pattern: number; stops: Place[]; departures: number[]; nowSec: number; shape: LatLon[] | null };

export default function LineView({ initialQ, initialRoute, setScene, setVehicles, openStop, me }: Props) {
  const [q, setQ] = useState(initialQ ?? '');
  const [vars, setVars] = useState<LineVariant[] | null>(null);
  const [sel, setSel] = useState<LineVariant | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [buses, setBuses] = useState<VehicleView[]>([]);
  const [allTimes, setAllTimes] = useState(false);
  const now = useNowSec();
  const saved = useSaved();
  const fav = sel ? saved.favLines.some((l) => l.gtfsRoute === sel.gtfsRoute) : false;

  useEffect(() => {
    setSel(null);
    if (!q.trim()) { setVars(null); return; }
    const t = setTimeout(() => api.searchLines(q, me).then((v) => {
      setVars(v);
      const pre = initialRoute !== undefined ? v.find((x) => x.gtfsRoute === initialRoute) : undefined;
      if (pre) setSel(pre);
    }).catch(() => setVars([])), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setDetail(null);
    setBuses([]);
    setVehicles([]);
    setAllTimes(false);
    if (!sel) return;
    let alive = true;
    api.patternDetail(sel.route).then((d) => alive && setDetail(d)).catch(() => {});
    return () => { alive = false; };
  }, [sel]);

  // live buses on this line: refresh often so they glide along the route
  useEffect(() => {
    if (!sel || !detail) return;
    let alive = true;
    const poll = () => api.vehiclesOnRoute(detail.date, sel.route).then((v) => {
      if (!alive) return;
      const live = v.filter((x) => x.ageSec < 15 * 60);
      setBuses(live);
      setVehicles(live);
    }).catch(() => {});
    poll();
    const i = setInterval(poll, 10000);
    return () => { alive = false; clearInterval(i); };
  }, [detail]);

  useEffect(() => {
    if (!sel || !detail) { setScene({ key: 'line-empty' }); return; }
    const coords = detail.shape ?? detail.stops.map((s) => [s.lat, s.lon] as LatLon);
    setScene({
      lines: [{ coords, color: sel.color, width: 5 }],
      points: detail.stops.map((s) => ({ lat: s.lat, lon: s.lon, color: sel.color, id: s.stop, small: true })),
      fit: coords,
      key: 'line' + sel.route,
    });
  }, [detail]);

  const upcoming = detail ? detail.departures.filter((t) => t >= now - 60) : [];
  const shown = allTimes ? detail?.departures ?? [] : upcoming.slice(0, 8);
  const toggleFav = () => sel && updateSaved((s) => ({
    ...s,
    favLines: fav ? s.favLines.filter((l) => l.gtfsRoute !== sel.gtfsRoute)
      : [...s.favLines, { gtfsRoute: sel.gtfsRoute, line: sel.line, to: sel.to, color: sel.color, rtype: sel.rtype }],
  }));

  return (
    <div className="lineview">
      <label className="busline big">
        <span>מספר קו</span>
        <input inputMode="numeric" placeholder="למשל 480" value={q} onChange={(e) => setQ(e.target.value.trim())} autoFocus={!initialQ} />
      </label>
      {vars && vars.length === 0 && <Empty title={`קו ${q} לא פעיל היום`}>בדקו את המספר. ייתכן שהקו לא פועל היום.</Empty>}
      {!sel && vars?.map((v) => (
        <button key={v.route} className="row variant" onClick={() => setSel(v)}>
          <LineBadge line={v.line} color={v.color} rtype={v.rtype} />
          <span className="row-txt"><b>ל{v.to}</b><small>מ{v.from}, {v.agencyName}</small></span>
          {v.distM !== undefined && <small className="away">{v.distM < 1000 ? `${Math.round(v.distM / 10) * 10} מ'` : `${(v.distM / 1000).toFixed(v.distM < 10000 ? 1 : 0)} ק"מ`}</small>}
        </button>
      ))}
      {sel && (
        <>
          <div className="line-head">
            <LineBadge line={sel.line} color={sel.color} rtype={sel.rtype} size="l" />
            <div className="row-txt"><b>ל{sel.to}</b><small>מ{sel.from}, {sel.agencyName}</small></div>
            <button className={'icon-btn' + (fav ? ' on' : '')} onClick={toggleFav} aria-label={fav ? 'הסרה מהקווים שלי' : 'הוספה לקווים שלי'}><IconStar /></button>
          </div>
          {vars && vars.length > 1 && <button className="link other-dir" onClick={() => setSel(null)}>כיוון אחר</button>}
          {!detail && <Spinner />}
          {detail && (
            <>
              <div className="veh-list">
                {buses.length === 0
                  ? <small className="muted">אין כרגע אוטובוסים של הקו עם מיקום בזמן אמת.</small>
                  : <small className="muted">{buses.length === 1 ? 'אוטובוס אחד בדרך כרגע' : `${buses.length} אוטובוסים בדרך כרגע`}</small>}
                {buses.slice(0, 6).map((b) => (
                  <div key={b.tripRef} className="veh-row">
                    <DelayBadge delay={b.delay} />
                    <span>ליד {b.nextStop}</span>
                  </div>
                ))}
              </div>
              <div className="next-deps">
                <small className="muted">{allTimes ? 'כל היציאות היום מתחנת המוצא:' : 'היציאות הבאות מתחנת המוצא:'}</small>
                <div>{shown.length ? shown.map((t, i) => <span key={i} className={t < now - 60 ? 'past' : ''}>{hm(t)}</span>) : <span className="muted">אין יותר היום</span>}</div>
                <button className="link" onClick={() => setAllTimes((x) => !x)}>{allTimes ? 'רק הקרובות' : 'לוח זמנים מלא להיום'}</button>
              </div>
              <ol className="line-stops" style={{ ['--c' as any]: sel.color }}>
                {detail.stops.map((s, i) => {
                  const here = buses.filter((b) => b.pos !== undefined && Math.round(b.pos) === i);
                  return (
                    <li key={i}>
                      <button onClick={() => openStop(s)}>
                        <span className="ls-dot" />
                        <span>{s.name}</span>
                        {here.length > 0 && <span className="ls-bus" aria-label="אוטובוס כאן">{sel.line}</span>}
                        <small>{s.sub}</small>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  );
}
