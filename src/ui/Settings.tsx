import type { Place } from '../engine/model';
import { getSaved, updateSaved, useSaved } from '../store';
import type { PickerOpts } from './PlacePicker';
import { IconClose, IconHome, IconStar, IconWork } from './icons';

interface Props {
  openPicker: (o: PickerOpts) => void;
  dataInfo: { built: string; days: string[] } | null;
}

export default function Settings({ openPicker, dataInfo }: Props) {
  const s = useSaved();
  const st = s.settings;
  const setPrefs = (p: Partial<typeof st.prefs>) => updateSaved((x) => ({ ...x, settings: { ...x.settings, prefs: { ...x.settings.prefs, ...p } } }));
  const setSt = (p: Partial<typeof st>) => updateSaved((x) => ({ ...x, settings: { ...x.settings, ...p } }));
  const setPlace = (k: 'home' | 'work') => openPicker({ title: k === 'home' ? 'איפה הבית?' : 'איפה העבודה או הלימודים?', allowCurrent: true, onPick: (p: Place) => updateSaved((x) => ({ ...x, [k]: { ...p, name: p.name } })) });

  return (
    <div className="settings">
      <h2 className="sec-h">המקומות שלי</h2>
      <PlaceRow icon={<IconHome />} label="בית" p={s.home} onSet={() => setPlace('home')} onClear={() => updateSaved((x) => ({ ...x, home: undefined }))} />
      <PlaceRow icon={<IconWork />} label="עבודה / לימודים" p={s.work} onSet={() => setPlace('work')} onClear={() => updateSaved((x) => ({ ...x, work: undefined }))} />
      {s.favorites.map((f, i) => (
        <PlaceRow key={i} icon={<IconStar />} label={f.name} p={f} onClear={() => updateSaved((x) => ({ ...x, favorites: x.favorites.filter((_, j) => j !== i) }))} />
      ))}

      <h2 className="sec-h">הליכה</h2>
      <Seg label="קצב הליכה" value={st.prefs.walkSpeed} options={[[1.0, 'איטי'], [1.25, 'רגיל'], [1.55, 'מהיר']]} onChange={(v) => setPrefs({ walkSpeed: v })} />
      <Seg label="הליכה מקסימלית לתחנה" value={st.prefs.maxWalk} options={[[500, "500 מ'"], [800, "800 מ'"], [1000, 'ק"מ'], [1500, '1.5 ק"מ']]} onChange={(v) => setPrefs({ maxWalk: v })} />
      <Seg label="זמן להחלפה" value={st.prefs.slack} options={[[60, "דקה"], [90, "דקה וחצי"], [180, "3 דק'"]]} onChange={(v) => setPrefs({ slack: v })} />

      <h2 className="sec-h">טרמפים</h2>
      <Seg label="ברירת מחדל לזמן נהיגה" value={st.driveMin} options={[[5, "5 דק'"], [10, "10 דק'"], [15, "15 דק'"], [20, "20 דק'"]]} onChange={(v) => setSt({ driveMin: v })} />
      <Seg label="עיקוף מקסימלי בטרמפ" value={st.detourMin} options={[[0, 'בלי'], [3, "3 דק'"], [5, "5 דק'"], [10, "10 דק'"]]} onChange={(v) => setSt({ detourMin: v })} />

      <h2 className="sec-h">התקנה באייפון</h2>
      <p className="muted">כדי שקדימה תיפתח כמו אפליקציה: בספארי, לחיצה על כפתור השיתוף ואז על "הוספה למסך הבית".</p>

      <h2 className="sec-h">נתונים</h2>
      <p className="muted small">
        לוחות זמנים: משרד התחבורה (GTFS){dataInfo ? `, עודכנו ${new Date(dataInfo.built).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' })}` : ''}.<br />
        מיקומי אוטובוסים: פרויקט "אוטובוס פתוח" של הסדנא לידע ציבורי.<br />
        מפות: OpenFreeMap ו-OpenStreetMap. זמני נסיעה ברכב: OSRM, מותאמים לשעות העומס.
      </p>
      <button className="link danger" onClick={() => { if (confirm('למחוק היסטוריית חיפושים?')) updateSaved((x) => ({ ...x, recents: [] })); }}>מחיקת היסטוריית חיפושים</button>
      <p className="muted small">{getSaved().recents.length} חיפושים אחרונים שמורים במכשיר בלבד.</p>
    </div>
  );
}

function PlaceRow({ icon, label, p, onSet, onClear }: { icon: JSX.Element; label: string; p?: Place; onSet?: () => void; onClear: () => void }) {
  return (
    <div className="prow">
      <span className="row-ic">{icon}</span>
      <button className="row-txt" onClick={onSet} disabled={!onSet}>
        <b>{label}</b>
        <small>{p ? p.name : 'לא הוגדר, הקישו להגדרה'}</small>
      </button>
      {p && <button className="icon-btn" aria-label="הסרה" onClick={onClear}><IconClose size={18} /></button>}
    </div>
  );
}

function Seg({ label, value, options, onChange }: { label: string; value: number; options: [number, string][]; onChange: (v: number) => void }) {
  return (
    <div className="setrow">
      <span>{label}</span>
      <div className="seg-ctl small">
        {options.map(([v, l]) => <button key={v} className={Math.abs(value - v) < 1e-6 ? 'on' : ''} onClick={() => onChange(v)}>{l}</button>)}
      </div>
    </div>
  );
}
