import { useSyncExternalStore } from 'react';
import type { Place, Prefs } from './engine/model';
import { DEFAULT_PREFS } from './engine/model';

export interface Settings {
  prefs: Prefs;
  driveMin: number; // default pickup/drop-off minutes
  lambda: number; // how much driver minutes count (0..1)
  detourMin: number;
}

export interface Saved {
  home?: Place;
  work?: Place;
  favorites: Place[];
  recents: Place[];
  settings: Settings;
}

const KEY = 'kadima:v1';
const DEFAULT: Saved = {
  favorites: [],
  recents: [],
  settings: { prefs: DEFAULT_PREFS, driveMin: 10, lambda: 0.3, detourMin: 3 },
};

function read(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const v = JSON.parse(raw);
    return { ...DEFAULT, ...v, settings: { ...DEFAULT.settings, ...v.settings, prefs: { ...DEFAULT.settings.prefs, ...v.settings?.prefs } } };
  } catch {
    return DEFAULT;
  }
}

let state = read();
const subs = new Set<() => void>();

export function getSaved() {
  return state;
}

export function updateSaved(fn: (s: Saved) => Saved) {
  state = fn(state);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
  subs.forEach((f) => f());
}

export function useSaved() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => state);
}

export function addRecent(p: Place) {
  if (p.name === 'המיקום שלי') return;
  updateSaved((s) => ({
    ...s,
    recents: [p, ...s.recents.filter((r) => !(Math.abs(r.lat - p.lat) < 1e-5 && Math.abs(r.lon - p.lon) < 1e-5))].slice(0, 12),
  }));
}
