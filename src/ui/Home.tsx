import { useEffect, useState } from 'react';
import type { Departure, Mode, Place } from '../engine/model';
import type { LatLon } from '../engine/geo';
import { distM } from '../engine/geo';
import { api, NearbyStop } from '../api';
import { useSaved } from '../store';
import type { Scene } from './MapView';
import { IconBus, IconDropoff, IconGear, IconHome, IconPickup, IconRoute, IconSearch, IconStar, IconThumb, IconWork } from './icons';
import { LineBadge, inMinutes, useNowSec } from './parts';

interface Props {
  me: LatLon | null;
  geoError: string | null;
  setScene: (s: Scene) => void;
  go: {
    plan: (mode: Mode, to?: Place) => void;
    stop: (p: Place) => void;
    line: () => void;
    settings: () => void;
    search: () => void;
    setPlace: (kind: 'home' | 'work') => void;
  };
}

const OPPS: { mode: Mode; title: string; sub: string; Icon: (p: { size?: number }) => JSX.Element }[] = [
  { mode: 'pickup', title: 'אוספים אותי', sub: 'מישהו יבוא לאסוף אותי מתחנה בדרך', Icon: IconPickup },
  { mode: 'dropoff', title: 'מקפיצים אותי', sub: 'טרמפ קצר לתחנה שתקצר לי את הדרך', Icon: IconDropoff },
  { mode: 'ride', title: 'אני בטרמפ', sub: 'איפה הכי כדאי לרדת מהרכב', Icon: IconThumb },
  { mode: 'onbus', title: 'אני באוטובוס', sub: 'באיזו תחנה לרדת ומה הלאה', Icon: IconBus },
];

export default function Home({ me, geoError, setScene, go }: Props) {
  const saved = useSaved();
  const [near, setNear] = useState<NearbyStop[] | null>(null);
  const [deps, setDeps] = useState<Record<number, Departure[]>>({});
  const now = useNowSec();
  // only refresh nearby stops when the user really moved (GPS jitters constantly)
  const [anchor, setAnchor] = useState<LatLon | null>(me);
  useEffect(() => {
    if (me && (!anchor || distM(anchor[0], anchor[1], me[0], me[1]) > 150)) setAnchor(me);
  }, [me]);
  const meKey = anchor ? `${anchor[0].toFixed(4)},${anchor[1].toFixed(4)}` : '';

  useEffect(() => {
    if (!anchor) return;
    const me = anchor;
    let alive = true;
    api.nearbyStops(me[0], me[1], 600, 10).then((r) => {
      if (!alive) return;
      setNear(r);
      setScene({
        points: r.map((s) => ({ lat: s.place.lat, lon: s.place.lon, id: s.place.stop, color: '#15202b' })),
        fit: [me],
        key: 'home' + meKey,
      });
    }).catch(() => setNear([]));
    return () => { alive = false; };
  }, [meKey]);

  useEffect(() => {
    if (!near?.length) return;
    let alive = true;
    const load = () => near.slice(0, 3).forEach((s) => {
      api.departures(s.place.stop!, undefined, 60).then((d) => alive && setDeps((x) => ({ ...x, [s.place.stop!]: d }))).catch(() => {});
    });
    load();
    const i = setInterval(load, 45000);
    return () => { alive = false; clearInterval(i); };
  }, [near]);

  useEffect(() => { if (!me) setScene({ key: 'home-nome' }); }, []);

  return (
    <div className="home">
      <button className="search-cta" onClick={() => go.search()}>
        <IconSearch />
        <span>לאן נוסעים?</span>
      </button>

      <div className="quick">
        <QuickPlace icon={<IconHome size={18} />} label="בית" place={saved.home} onGo={(p) => go.plan('transit', p)} onSet={() => go.setPlace('home')} />
        <QuickPlace icon={<IconWork size={18} />} label="עבודה" place={saved.work} onGo={(p) => go.plan('transit', p)} onSet={() => go.setPlace('work')} />
        {saved.favorites.slice(0, 4).map((f, i) => (
          <button key={i} className="qp" onClick={() => go.plan('transit', f)}><IconStar size={18} /><span>{f.name}</span></button>
        ))}
      </div>

      <h2 className="sec-h">הזדמנויות בדרך</h2>
      <div className="opps">
        {OPPS.map(({ mode, title, sub, Icon }) => (
          <button key={mode} className="opp" onClick={() => go.plan(mode)}>
            <span className="opp-ic"><Icon size={26} /></span>
            <b>{title}</b>
            <small>{sub}</small>
          </button>
        ))}
      </div>

      <h2 className="sec-h">תחנות קרובות</h2>
      {geoError && !me && <p className="muted">{geoError}</p>}
      {me && !near && <p className="muted">מחפש תחנות סביבך…</p>}
      {near?.length === 0 && <p className="muted">אין תחנות פעילות במרחק הליכה קצר.</p>}
      <div className="near">
        {near?.slice(0, 6).map((s, idx) => {
          const d = deps[s.place.stop!];
          const grouped = groupNext(d || []);
          return (
            <button key={s.place.stop} className="near-stop" onClick={() => go.stop(s.place)}>
              <div className="ns-head">
                <b>{s.place.name}</b>
                <small>{s.dist} מ'</small>
              </div>
              {idx < 3 && d ? (
                <div className="ns-deps">
                  {grouped.slice(0, 4).map((g) => (
                    <span key={g.key} className="ns-dep">
                      <LineBadge line={g.d.line} color={g.d.color} rtype={g.d.rtype} size="s" />
                      <span className={g.d.live ? 'livetxt' : ''}>{inMinutes(g.d.time, now)}</span>
                    </span>
                  ))}
                  {grouped.length === 0 && <small className="muted">אין יציאות בשעה הקרובה</small>}
                </div>
              ) : (
                <div className="ns-lines">{s.lines.slice(0, 10).map(([l, c]) => <LineBadge key={l} line={l} color={c} size="s" />)}</div>
              )}
            </button>
          );
        })}
      </div>

      <div className="home-foot">
        <button className="ghost" onClick={() => go.line()}><IconRoute size={18} />חיפוש קו</button>
        <button className="ghost" onClick={() => go.settings()}><IconGear size={18} />הגדרות</button>
      </div>
    </div>
  );
}

function QuickPlace({ icon, label, place, onGo, onSet }: { icon: JSX.Element; label: string; place?: Place; onGo: (p: Place) => void; onSet: () => void }) {
  return (
    <button className={'qp' + (place ? '' : ' unset')} onClick={() => (place ? onGo(place) : onSet())}>
      {icon}<span>{place ? label : `הגדרת ${label}`}</span>
    </button>
  );
}

export function groupNext(deps: Departure[]) {
  const seen = new Map<string, { key: string; d: Departure; more: Departure[] }>();
  for (const d of deps) {
    const k = d.line + '|' + d.headsign;
    const g = seen.get(k);
    if (!g) seen.set(k, { key: k, d, more: [] });
    else if (g.more.length < 3) g.more.push(d);
  }
  return [...seen.values()];
}
