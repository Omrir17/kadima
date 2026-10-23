import { useEffect, useState } from 'react';
import type { Departure, Mode, Place } from '../engine/model';
import { api } from '../api';
import { hm } from '../engine/time';
import { updateSaved, useSaved } from '../store';
import type { Scene } from './MapView';
import { groupNext } from './Home';
import { IconStar } from './icons';
import { Empty, LineBadge, Spinner, inMinutes, useNowSec } from './parts';

interface Props {
  place: Place;
  setScene: (s: Scene) => void;
  planTo: (mode: Mode, to: Place) => void;
  openLine: (q: string) => void;
}

export default function StopView({ place, setScene, planTo, openLine }: Props) {
  const [deps, setDeps] = useState<Departure[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNowSec();
  const saved = useSaved();
  const fav = saved.favorites.some((f) => f.stop === place.stop);

  useEffect(() => {
    setScene({ points: [{ lat: place.lat, lon: place.lon, color: '#15202b', id: place.stop }], fit: [[place.lat, place.lon]], key: 'stop' + place.stop });
    let alive = true;
    const load = () => api.departures(place.stop!, undefined, 120).then((d) => alive && setDeps(d)).catch((e) => alive && setErr(e.message));
    load();
    const i = setInterval(load, 30000);
    return () => { alive = false; clearInterval(i); };
  }, [place.stop]);

  const groups = groupNext(deps || []);

  return (
    <div className="stopview">
      <div className="sv-head">
        <div>
          <h1>{place.name}</h1>
          <small className="muted">{place.sub ? place.sub + ', ' : ''}תחנה {place.code}</small>
        </div>
        <button className={'icon-btn' + (fav ? ' on' : '')} aria-label="מועדפים" onClick={() => updateSaved((s) => ({ ...s, favorites: fav ? s.favorites.filter((f) => f.stop !== place.stop) : [...s.favorites, place] }))}>
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
            <button className="dep" onClick={() => openLine(g.d.line)}>
              <LineBadge line={g.d.line} color={g.d.color} rtype={g.d.rtype} />
              <span className="dep-txt"><b>ל{g.d.headsign}</b></span>
              <span className="dep-times">
                <span className={'dep-first' + (g.d.live ? ' livetxt' : '')}>{inMinutes(g.d.time, now)}</span>
                <small>{g.more.map((m) => (m.time - now < 3600 ? inMinutes(m.time, now) : hm(m.time))).join(', ')}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p className="muted small pad">זמנים בירוק מבוססים על מיקום האוטובוס בזמן אמת.</p>
    </div>
  );
}
