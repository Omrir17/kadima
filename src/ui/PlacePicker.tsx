import { useEffect, useRef, useState } from 'react';
import type { Place } from '../engine/model';
import type { LatLon } from '../engine/geo';
import { api } from '../api';
import { geocode } from '../services/geocode';
import { useSaved } from '../store';
import { IconBack, IconBus, IconClock, IconHome, IconLocate, IconMap, IconPin, IconStar, IconWork } from './icons';

export interface PickerOpts {
  title: string;
  allowCurrent?: boolean;
  onPick: (p: Place) => void;
}

interface Props extends PickerOpts {
  me: LatLon | null;
  onClose: () => void;
  onPickOnMap: () => void;
}

export const ME_NAME = 'המיקום שלי';

export default function PlacePicker({ title, allowCurrent, onPick, onClose, onPickOnMap, me }: Props) {
  const saved = useSaved();
  const [q, setQ] = useState('');
  const [stops, setStops] = useState<Place[]>([]);
  const [addrs, setAddrs] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => input.current?.focus(), 50); }, []);

  useEffect(() => {
    const qq = q.trim();
    if (qq.length < 2) { setStops([]); setAddrs([]); return; }
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      api.searchStops(qq, me ?? undefined).then((r) => !ctl.signal.aborted && setStops(r)).catch(() => {});
      try {
        const r = await geocode(qq, me ?? undefined, ctl.signal);
        if (!ctl.signal.aborted) setAddrs(r);
      } catch { /* offline */ }
      if (!ctl.signal.aborted) setBusy(false);
    }, 280);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);

  const pick = (p: Place) => { onClose(); onPick(p); };
  const fixed: { icon: JSX.Element; p: Place; label: string }[] = [];
  if (saved.home) fixed.push({ icon: <IconHome />, p: saved.home, label: 'בית' });
  if (saved.work) fixed.push({ icon: <IconWork />, p: saved.work, label: 'עבודה / לימודים' });
  saved.favorites.forEach((f) => fixed.push({ icon: <IconStar />, p: f, label: f.name }));

  return (
    <div className="overlay" role="dialog" aria-label={title}>
      <div className="picker-head">
        <button className="icon-btn" onClick={onClose} aria-label="חזרה"><IconBack /></button>
        <input
          ref={input}
          className="picker-input"
          placeholder={title}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
      </div>
      <div className="picker-list">
        {!q && (
          <>
            {allowCurrent && (
              <Row icon={<IconLocate />} title={ME_NAME} sub={me ? 'לפי GPS' : 'צריך לאשר גישה למיקום'} onClick={() => me && pick({ name: ME_NAME, lat: me[0], lon: me[1] })} />
            )}
            {fixed.map((f) => <Row key={f.label + f.p.lat} icon={f.icon} title={f.label} sub={f.label === f.p.name ? f.p.sub : f.p.name} onClick={() => pick(f.p)} />)}
            <Row icon={<IconMap />} title="לבחור על המפה" onClick={() => { onPickOnMap(); onClose(); }} />
            {saved.recents.length > 0 && <h3 className="list-h">אחרונים</h3>}
            {saved.recents.map((r, i) => <Row key={i} icon={<IconClock />} title={r.name} sub={r.sub} onClick={() => pick(r)} />)}
          </>
        )}
        {q && (
          <>
            {addrs.map((a, i) => <Row key={'a' + i} icon={<IconPin />} title={a.name} sub={a.sub} onClick={() => pick(a)} />)}
            {stops.length > 0 && <h3 className="list-h">תחנות</h3>}
            {stops.map((s) => <Row key={'s' + s.stop} icon={<IconBus />} title={s.name} sub={`${s.sub ? s.sub + ', ' : ''}תחנה ${s.code}`} onClick={() => pick(s)} />)}
            {!busy && !addrs.length && !stops.length && q.trim().length >= 2 && <div className="muted pad">לא נמצאו תוצאות. נסו שם רחוב ועיר, או מספר תחנה.</div>}
            {busy && !addrs.length && <div className="muted pad">מחפש…</div>}
          </>
        )}
      </div>
    </div>
  );
}

function Row({ icon, title, sub, onClick }: { icon: JSX.Element; title: string; sub?: string; onClick: () => void }) {
  return (
    <button className="row" onClick={onClick}>
      <span className="row-ic">{icon}</span>
      <span className="row-txt"><b>{title}</b>{sub && <small>{sub}</small>}</span>
    </button>
  );
}
