import { useEffect, useState } from 'react';
import type { LineVariant, Place, VehicleView } from '../engine/model';
import type { LatLon } from '../engine/geo';
import { api } from '../api';
import { hm } from '../engine/time';
import type { Scene } from './MapView';
import { DelayBadge, Empty, LineBadge, Spinner, useNowSec } from './parts';

interface Props {
  initialQ?: string;
  setScene: (s: Scene) => void;
  openStop: (p: Place) => void;
}

type Detail = { date: string; pattern: number; stops: Place[]; departures: number[]; nowSec: number; shape: LatLon[] | null };

export default function LineView({ initialQ, setScene, openStop }: Props) {
  const [q, setQ] = useState(initialQ ?? '');
  const [vars, setVars] = useState<LineVariant[] | null>(null);
  const [sel, setSel] = useState<LineVariant | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [vehicles, setVehicles] = useState<VehicleView[]>([]);
  const now = useNowSec();

  useEffect(() => {
    setSel(null);
    if (!q.trim()) { setVars(null); return; }
    const t = setTimeout(() => api.searchLines(q).then(setVars).catch(() => setVars([])), 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setDetail(null);
    setVehicles([]);
    if (!sel) return;
    let alive = true;
    api.patternDetail(sel.route).then((d) => alive && setDetail(d)).catch(() => {});
    return () => { alive = false; };
  }, [sel]);

  useEffect(() => {
    if (!sel || !detail) return;
    let alive = true;
    const poll = () => api.vehiclesOnRoute(detail.date, sel.route).then((v) => alive && setVehicles(v.filter((x) => x.ageSec < 300))).catch(() => {});
    poll();
    const i = setInterval(poll, 20000);
    return () => { alive = false; clearInterval(i); };
  }, [detail]);

  useEffect(() => {
    if (!sel || !detail) { setScene({ key: 'line-empty' }); return; }
    const coords = detail.shape ?? detail.stops.map((s) => [s.lat, s.lon] as LatLon);
    setScene({
      lines: [{ coords, color: sel.color, width: 5 }],
      points: detail.stops.map((s) => ({ lat: s.lat, lon: s.lon, color: sel.color, id: s.stop, small: true })),
      vehicles: vehicles.map((v) => ({ lat: v.lat, lon: v.lon, color: v.color, label: v.line, late: (v.delay ?? 0) > 180 })),
      fit: coords,
      key: 'line' + sel.route,
    });
  }, [detail, vehicles]);

  const nextDeps = detail ? detail.departures.filter((t) => t >= now - 60).slice(0, 8) : [];

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
        </button>
      ))}
      {sel && (
        <>
          <div className="line-head">
            <LineBadge line={sel.line} color={sel.color} rtype={sel.rtype} size="l" />
            <div className="row-txt"><b>ל{sel.to}</b><small>מ{sel.from}, {sel.agencyName}</small></div>
            <button className="link" onClick={() => setSel(null)}>כיוון אחר</button>
          </div>
          {!detail && <Spinner />}
          {detail && (
            <>
              <div className="next-deps">
                <small className="muted">יציאות מתחנת המוצא:</small>
                <div>{nextDeps.length ? nextDeps.map((t) => <span key={t}>{hm(t)}</span>) : <span className="muted">אין יותר היום</span>}</div>
              </div>
              {vehicles.length > 0 && (
                <div className="veh-list">
                  <small className="muted">{vehicles.length === 1 ? 'אוטובוס אחד בדרך כרגע' : `${vehicles.length} אוטובוסים בדרך כרגע`}</small>
                  <div>{vehicles.slice(0, 6).map((v, i) => <DelayBadge key={i} delay={v.delay} />)}</div>
                </div>
              )}
              <ol className="line-stops" style={{ ['--c' as any]: sel.color }}>
                {detail.stops.map((s, i) => (
                  <li key={i}><button onClick={() => openStop(s)}><span className="ls-dot" /><span>{s.name}</span><small>{s.sub}</small></button></li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
    </div>
  );
}
