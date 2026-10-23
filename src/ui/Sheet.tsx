import { ReactNode, useEffect, useRef, useState } from 'react';

export type Snap = 'peek' | 'half' | 'full';
const FRAC: Record<Snap, number> = { peek: 0.3, half: 0.58, full: 0.93 };

interface Props {
  snap: Snap;
  onSnap: (s: Snap) => void;
  onHeight: (px: number) => void;
  header?: ReactNode;
  children: ReactNode;
}

export default function Sheet({ snap, onSnap, onHeight, header, children }: Props) {
  const [vh, setVh] = useState(() => window.innerHeight);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; t: number } | null>(null);
  const height = drag ?? Math.round(vh * FRAC[snap]);

  useEffect(() => {
    const r = () => setVh(window.innerHeight);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);
  useEffect(() => { if (drag === null) onHeight(height); }, [height, drag]);

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input, select, a, textarea')) return;
    start.current = { y: e.clientY, h: height, t: Date.now() };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const move = (e: React.PointerEvent) => {
    if (!start.current) return;
    const dy = start.current.y - e.clientY;
    if (drag === null && Math.abs(dy) < 6) return;
    setDrag(Math.max(vh * 0.16, Math.min(vh * 0.95, start.current.h + dy)));
  };
  const up = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    if (drag === null || !s) { setDrag(null); return; }
    const v = (s.y - e.clientY) / Math.max(1, Date.now() - s.t); // px/ms, positive = up
    let target = drag + v * 250;
    const opts: Snap[] = ['peek', 'half', 'full'];
    let best: Snap = snap, bd = Infinity;
    for (const o of opts) {
      const d = Math.abs(vh * FRAC[o] - target);
      if (d < bd) { bd = d; best = o; }
    }
    setDrag(null);
    onSnap(best);
  };

  return (
    <section className={'sheet' + (drag !== null ? ' dragging' : '')} style={{ height }} aria-label="תוכן">
      <div className="sheet-grab" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="grabber" onClick={() => onSnap(snap === 'full' ? 'half' : snap === 'half' ? 'full' : 'half')} />
        {header}
      </div>
      <div className="sheet-body">{children}</div>
    </section>
  );
}
