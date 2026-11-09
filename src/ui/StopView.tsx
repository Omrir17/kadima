import { useEffect, useRef, useState } from 'react';
import type { Departure, Mode, Place, VehicleView } from '../engine/model';
import { api } from '../api';
import { hm } from '../engine/time';
import { updateSaved, useSaved } from '../store';
import type { Scene } from './MapView';
import { groupNext } from './Home';
import { IconStar } from './icons';
import { Empty, LineBadge, LiveIcon, Mins, Spinner, useNowSec } from './parts';

interface Props {
  place: Place;
  setScene: (s: Scene) => void;
  setVehicles: (v: VehicleView[]) => void;
  focusVehicle: (id: string | null) => void;
  planTo: (mode: Mode, to: Place) => void;
  openLine: (q: string, gtfsRoute?: number) => void;
}

export default function StopView({ place, setScene, setVehicles, focusVehicle, planTo, openLine }: Props) {
  const [deps, setDeps] = useState<Departure[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNowSec();
  const nowRef = useRef(now);
  nowRef.current = now;
  const saved = useSaved();
  const fav = saved.favorites.some((f) => f.stop === place.stop);

  useEffect(() => {
    setScene({ points: [{ lat: place.lat, lon: place.lon, color: '#15202b', id: place.stop }], fit: [[place.lat, place.lon]], key: 'stop' + place.stop });
    let alive = true;
    let fitted = false;
    const load = () => api.stopBoard(place.stop!, undefined, 120).then((b) => {
      if (!alive) return;
      setDeps(b.deps);
      setVehicles(b.vehicles);
      // once: zoom out enough to show the buses arriving in the next ~15 minutes
      const soon = b.vehicles.filter((v) => b.deps.some((d) => d.live && d.tripRef === v.tripRef && d.time - nowRef.current < 15 * 60));
      if (!fitted && soon.length) {
        fitted = true;
        setScene({
          points: [{ lat: place.lat, lon: place.lon, color: '#15202b', id: place.stop }],
          fit: [[place.lat, place.lon], ...soon.slice(0, 6).map((v) => [v.lat, v.lon] as [number, number])],
          key: 'stop' + place.stop + ':buses',
        });
      }
    }).catch((e) => alive && setErr(e.message));
    load();
    const i = setInterval(load, 15000);
    return () => { alive = false; clearInterval(i); };
  }, [place.stop]);

  const groups = groupNext(deps || []);
  const anyLive = (deps || []).some((d) => d.live);

  return (
    <div className="stopview">
      <div className="sv-head">
        <div>
          <h1>{place.name}</h1>
          <small className="muted">{place.sub ? place.sub + ', ' : ''}תחנה {place.code}</small>
        </div>
        <button className={'icon-btn' + (fav ? ' on' : '')} aria-label={fav ? 'הסרה מהמועדפים' : 'הוספה למועדפים'}
          onClick={() => updateSaved((s) => ({ ...s, favorites: fav ? s.favorites.filter((f) => f.stop !== place.stop) : [...s.favorites, place] }))}>
          <IconStar />
        </button>
      </div>
      <div className="sv-actions">
        <button className="btn" onClick={() => planTo('transit', place)}>מסלול לכאן</button>
      </div>
      {!deps && !err && <Spinner label="טוען יציאות" />}
      {err && <Empty title="לא הצלחנו לטעון יציאות">{err}</Empty>}
      {deps && groups.length === 0 && <Empty title="אין יציאות בשעתיים הקרובות" />}
      <ul className="deps">
        {groups.map((g) => (
          <li key={g.key}>
            <div className="dep">
              <button className="dep-line" onClick={() => openLine(g.d.line, g.d.gtfsRoute)} aria-label={`קו ${g.d.line}`}>
                <LineBadge line={g.d.line} color={g.d.color} rtype={g.d.rtype} />
              </button>
              <button className="dep-txt" onClick={() => (g.d.live ? focusVehicle(String(g.d.tripRef)) : openLine(g.d.line, g.d.gtfsRoute))}>
                <b>ל{g.d.headsign}</b>
                {g.d.live && g.d.stopsAway !== undefined && (
                  <small className="away">{g.d.stopsAway === 0 ? 'מגיע לתחנה' : g.d.stopsAway === 1 ? 'תחנה אחת מכאן' : `${g.d.stopsAway} תחנות מכאן`}</small>
                )}
              </button>
              <span className="dep-times">
                <Mins sec={g.d.time} now={now} live={g.d.live} className="dep-first" />
                <small>{g.more.map((m) => (m.time - now < 3600 ? `${Math.max(0, Math.round((m.time - now) / 60))}${m.live ? '*' : ''}` : hm(m.time))).join(', ')}{g.more.length && g.more[0].time - now < 3600 ? " דק'" : ''}</small>
              </span>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small pad legend">
        <span className="mins is-live"><LiveIcon />ירוק</span> = זמן אמת לפי מיקום האוטובוס. שחור = לפי לוח הזמנים. כוכבית = זמן אמת.
        {!anyLive && deps && deps.length > 0 && ' אין כרגע נתוני זמן אמת לקווים בתחנה.'}
      </p>
    </div>
  );
}
