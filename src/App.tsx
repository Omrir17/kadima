import { useCallback, useEffect, useState } from 'react';
import type { Itinerary, Mode, Place } from './engine/model';
import type { LatLon } from './engine/geo';
import { api } from './api';
import { addRecent, updateSaved } from './store';
import { reverseGeocode } from './services/geocode';
import MapView, { Scene } from './ui/MapView';
import Sheet, { Snap } from './ui/Sheet';
import Home from './ui/Home';
import Plan, { PlanInit } from './ui/Plan';
import Trip from './ui/Trip';
import StopView from './ui/StopView';
import LineView from './ui/LineView';
import Settings from './ui/Settings';
import PlacePicker, { PickerOpts } from './ui/PlacePicker';
import { IconBack, IconLocate } from './ui/icons';
import { Spinner } from './ui/parts';

type View =
  | { name: 'home' }
  | { name: 'plan'; init: PlanInit }
  | { name: 'trip'; it: Itinerary; mode: Mode; baseline?: Itinerary | null }
  | { name: 'stop'; place: Place }
  | { name: 'line'; q?: string }
  | { name: 'settings' };

const TITLES: Partial<Record<View['name'], string>> = { line: 'קווים', settings: 'הגדרות', trip: 'המסלול' };

function useGeo() {
  const [pos, setPos] = useState<LatLon | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // ?at=lat,lon simulates a position (handy for testing)
    const at = new URLSearchParams(location.search).get('at');
    if (at) { const [a, b] = at.split(',').map(Number); if (a && b) { setPos([a, b]); return; } }
    if (!navigator.geolocation) { setErr('המכשיר לא תומך במיקום'); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => { setPos([p.coords.latitude, p.coords.longitude]); setErr(null); },
      (e) => setErr(e.code === 1 ? 'אין הרשאת מיקום. אפשר לאשר בהגדרות הדפדפן, או לבחור נקודת מוצא ידנית.' : 'לא הצלחנו לקבל מיקום'),
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return { pos, err };
}

export default function App() {
  const [ready, setReady] = useState<{ built: string; days: string[] } | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [stack, setStack] = useState<View[]>([{ name: 'home' }]);
  const [scene, setScene] = useState<Scene>({});
  const [snap, setSnap] = useState<Snap>('half');
  const [sheetH, setSheetH] = useState(300);
  const [picker, setPicker] = useState<PickerOpts | null>(null);
  const [mapPick, setMapPick] = useState<((p: Place) => void) | null>(null);
  const [recenter, setRecenter] = useState(0);
  const { pos: me, err: geoErr } = useGeo();
  const view = stack[stack.length - 1];

  // ----- boot: fetch data version, init the worker
  useEffect(() => {
    const base = new URL('data/', document.baseURI).href;
    fetch(base + 'meta.json', { cache: 'no-cache' })
      .then((r) => r.json())
      .then((m) => api.init(base, m.built))
      .then((info) => setReady({ built: info.built, days: info.days }))
      .catch((e) => setLoadErr(e.message || 'טעינה נכשלה'));
  }, []);

  // ----- navigation with browser history (iOS swipe-back, Android back button)
  const push = useCallback((v: View) => {
    setStack((s) => [...s, v]);
    history.pushState({ depth: Date.now() }, '');
  }, []);
  const back = useCallback(() => history.back(), []);
  useEffect(() => {
    const onPop = () => {
      setPicker(null);
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    // pick a sensible sheet height per screen
    if (view.name === 'home') setSnap('half');
    else if (view.name === 'trip' || view.name === 'plan') setSnap('half');
    else if (view.name === 'settings' || view.name === 'line') setSnap('full');
    else setSnap('half');
  }, [view]);

  const openPicker = (o: PickerOpts) => setPicker(o);
  const closePicker = () => setPicker(null);

  const go = {
    plan: (mode: Mode, to?: Place) => push({ name: 'plan', init: { mode, to } }),
    stop: (place: Place) => push({ name: 'stop', place }),
    line: (q?: string) => push({ name: 'line', q }),
    settings: () => push({ name: 'settings' }),
    search: () => openPicker({ title: 'לאן נוסעים?', onPick: (p) => { addRecent(p); push({ name: 'plan', init: { mode: 'transit', to: p } }); } }),
    setPlace: (k: 'home' | 'work') => openPicker({ title: k === 'home' ? 'איפה הבית?' : 'איפה העבודה או הלימודים?', allowCurrent: true, onPick: (p) => updateSaved((x) => ({ ...x, [k]: p })) }),
  };

  const onMapClick = async (lat: number, lon: number) => {
    if (!mapPick) return;
    const cb = mapPick;
    setMapPick(null);
    const name = await reverseGeocode(lat, lon);
    cb({ lat, lon, name });
  };

  const onPointClick = async (stop: number) => {
    if (mapPick) return;
    const p = await api.stopPlace(stop).catch(() => null);
    if (p) go.stop(p);
  };

  if (loadErr) {
    return (
      <div className="splash">
        <div className="logo">קדימה</div>
        <p>לא הצלחנו לטעון את לוחות הזמנים.</p>
        <small>{loadErr}</small>
        <button className="btn" onClick={() => location.reload()}>לנסות שוב</button>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="splash">
        <div className="logo">קדימה</div>
        <Spinner label="טוען לוחות זמנים" />
      </div>
    );
  }

  const header = view.name !== 'home' && (
    <div className="sheet-head">
      <button className="icon-btn" onClick={back} aria-label="חזרה"><IconBack /></button>
      <h1>{view.name === 'stop' ? 'תחנה' : view.name === 'plan' ? 'תכנון מסלול' : TITLES[view.name]}</h1>
    </div>
  );

  return (
    <div className="app">
      <MapView scene={scene} me={me} bottomPad={sheetH} onMapClick={onMapClick} onPointClick={onPointClick} recenterSignal={recenter} />
      {view.name === 'home' && <div className="brand" aria-hidden>קדימה</div>}
      <button className="locate" style={{ bottom: sheetH + 14 }} onClick={() => setRecenter((x) => x + 1)} aria-label="המיקום שלי"><IconLocate /></button>
      {mapPick && (
        <div className="mappick">
          הקישו על המפה כדי לבחור נקודה
          <button className="link" onClick={() => setMapPick(null)}>ביטול</button>
        </div>
      )}
      <Sheet snap={snap} onSnap={setSnap} onHeight={setSheetH} header={header}>
        {view.name === 'home' && <Home me={me} geoError={geoErr} setScene={setScene} go={go} />}
        {view.name === 'plan' && (
          <Plan
            key={stack.length}
            init={view.init}
            me={me}
            openPicker={openPicker}
            setScene={setScene}
            onOpenTrip={(it, ctx) => push({ name: 'trip', it, mode: ctx.mode, baseline: ctx.baseline })}
          />
        )}
        {view.name === 'trip' && <Trip it={view.it} mode={view.mode} baseline={view.baseline} setScene={setScene} openStop={go.stop} />}
        {view.name === 'stop' && <StopView key={view.place.stop} place={view.place} setScene={setScene} planTo={go.plan} openLine={(q) => go.line(q)} />}
        {view.name === 'line' && <LineView initialQ={view.q} setScene={setScene} openStop={go.stop} />}
        {view.name === 'settings' && <Settings openPicker={openPicker} dataInfo={ready} />}
      </Sheet>
      {picker && (
        <PlacePicker
          {...picker}
          me={me}
          onClose={closePicker}
          onPickOnMap={() => { const cb = picker.onPick; setTimeout(() => setMapPick(() => cb), 0); setSnap('peek'); }}
        />
      )}
    </div>
  );
}
