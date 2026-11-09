import { useEffect, useRef } from 'react';
import maplibregl, { GeoJSONSource, LngLatBoundsLike } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { LatLon } from '../engine/geo';

export interface MapLine { coords: LatLon[]; color: string; width?: number; dash?: boolean }
export interface MapPoint { lat: number; lon: number; color?: string; id?: number; small?: boolean }
export interface MapPin { lat: number; lon: number; kind: 'start' | 'end' | 'car' | 'pin'; label?: string }
export interface MapVehicle { id: string; lat: number; lon: number; color: string; label: string; bearing?: number; late?: boolean; dim?: boolean }

export interface Scene {
  lines?: MapLine[];
  points?: MapPoint[];
  pins?: MapPin[];
  fit?: LatLon[];
  key?: string; // change to refit
}

interface Props {
  scene: Scene;
  me: LatLon | null;
  bottomPad: number;
  onMapClick?: (lat: number, lon: number) => void;
  onPointClick?: (id: number) => void;
  recenterSignal?: number;
  /** live buses: updated often, animated in place (not part of the scene) */
  vehicles?: MapVehicle[];
  onVehicleClick?: (id: string) => void;
  /** keep the map centred on my position (live trip tracking) */
  follow?: boolean;
}

interface VehMarker { marker: maplibregl.Marker; el: HTMLDivElement; lat: number; lon: number; anim?: number }

const STYLE = 'https://tiles.openfreemap.org/styles/positron';
let rtlSet = false;

export default function MapView({ scene, me, bottomPad, onMapClick, onPointClick, recenterSignal, vehicles, onVehicleClick, follow }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const loaded = useRef(false);
  const markers = useRef<maplibregl.Marker[]>([]);
  const meMarker = useRef<maplibregl.Marker | null>(null);
  const vehMarkers = useRef(new Map<string, VehMarker>());
  const cb = useRef({ onMapClick, onPointClick, onVehicleClick });
  cb.current = { onMapClick, onPointClick, onVehicleClick };
  const lastFit = useRef<string>('');
  const padRef = useRef(bottomPad);
  padRef.current = bottomPad;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;

  useEffect(() => {
    if (!rtlSet) {
      rtlSet = true;
      try { maplibregl.setRTLTextPlugin('https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js', true); } catch { /* already set */ }
    }
    const m = new maplibregl.Map({
      container: el.current!,
      style: STYLE,
      center: [34.85, 32.0],
      zoom: 9,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    map.current = m;
    if (import.meta.env.DEV) (window as any).__kmap = m;
    m.on('load', () => {
      // Hebrew labels first
      for (const layer of m.getStyle().layers || []) {
        if (layer.type === 'symbol' && (layer.layout as any)?.['text-field']) {
          try { m.setLayoutProperty(layer.id, 'text-field', ['coalesce', ['get', 'name:he'], ['get', 'name'], ['get', 'name_en']]); } catch { /* ignore */ }
        }
      }
      m.addSource('lines', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addSource('points', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      m.addLayer({ id: 'line-casing', type: 'line', source: 'lines', filter: ['!', ['get', 'dash']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['+', ['get', 'width'], 4] } });
      m.addLayer({ id: 'line-solid', type: 'line', source: 'lines', filter: ['!', ['get', 'dash']], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] } });
      m.addLayer({ id: 'line-dash', type: 'line', source: 'lines', filter: ['get', 'dash'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': ['get', 'width'], 'line-dasharray': [0.1, 2] } });
      m.addLayer({
        id: 'points', type: 'circle', source: 'points',
        paint: {
          'circle-radius': ['case', ['get', 'small'], 3.5, 6],
          'circle-color': '#ffffff',
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['case', ['get', 'small'], 2, 3],
        },
      });
      m.on('mouseenter', 'points', () => (m.getCanvas().style.cursor = 'pointer'));
      m.on('mouseleave', 'points', () => (m.getCanvas().style.cursor = ''));
      loaded.current = true;
      apply(sceneRef.current);
    });
    m.on('click', (e) => {
      if (loaded.current && cb.current.onPointClick) {
        const r = 14; // finger-sized hit box
        const fs = m.queryRenderedFeatures([[e.point.x - r, e.point.y - r], [e.point.x + r, e.point.y + r]], { layers: ['points'] });
        const f = fs.find((x) => x.properties?.id !== undefined && x.properties?.id !== null);
        if (f) { cb.current.onPointClick(Number(f.properties!.id)); return; }
      }
      cb.current.onMapClick?.(e.lngLat.lat, e.lngLat.lng);
    });
    return () => { m.remove(); map.current = null; loaded.current = false; };
  }, []);

  function apply(sc: Scene) {
    const m = map.current;
    if (!m || !loaded.current) return;
    (m.getSource('lines') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (sc.lines || []).filter((l) => l.coords.length > 1).map((l) => ({
        type: 'Feature',
        properties: { color: l.color, width: l.width ?? 5, dash: !!l.dash },
        geometry: { type: 'LineString', coordinates: l.coords.map(([a, b]) => [b, a]) },
      })),
    });
    (m.getSource('points') as GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: (sc.points || []).map((p) => ({
        type: 'Feature',
        properties: { color: p.color || '#15202b', id: p.id ?? null, small: !!p.small },
        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      })),
    });
    markers.current.forEach((mk) => mk.remove());
    markers.current = [];
    for (const p of sc.pins || []) {
      const d = document.createElement('div');
      d.className = 'pin pin-' + p.kind;
      if (p.label) d.innerHTML = `<span>${escapeHtml(p.label)}</span>`;
      markers.current.push(new maplibregl.Marker({ element: d, anchor: p.kind === 'pin' || p.kind === 'end' ? 'bottom' : 'center' }).setLngLat([p.lon, p.lat]).addTo(m));
    }
    const key = sc.key ?? '';
    if (sc.fit && sc.fit.length && key !== lastFit.current) {
      lastFit.current = key;
      fitTo(sc.fit);
    }
  }

  function fitTo(pts: LatLon[]) {
    const m = map.current;
    if (!m) return;
    // padding passed to easeTo/fitBounds persists on the map and stacks up; reset it each time
    m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    if (pts.length === 1) {
      m.easeTo({ center: [pts[0][1], pts[0][0]], zoom: 15.5, offset: [0, -Math.round(padRef.current / 2) + 20], duration: 600 });
      return;
    }
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
    for (const [la, lo] of pts) {
      minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la);
      minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo);
    }
    const b: LngLatBoundsLike = [[minLo, minLa], [maxLo, maxLa]];
    const h = m.getContainer().clientHeight;
    const bottom = Math.min(padRef.current + 30, h - 160);
    m.fitBounds(b, { padding: { top: 70, bottom, left: 40, right: 40 }, maxZoom: 16, duration: 700 });
  }

  useEffect(() => { apply(scene); }, [scene]);

  // live buses: create / glide / remove markers without touching the rest of the map
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<string>();
    for (const v of vehicles || []) {
      seen.add(v.id);
      let vm = vehMarkers.current.get(v.id);
      if (!vm) {
        // outer element belongs to MapLibre (it adds positioning classes); we style an inner one
        const outer = document.createElement('div');
        const el = document.createElement('div');
        outer.appendChild(el);
        outer.addEventListener('click', (e) => { e.stopPropagation(); cb.current.onVehicleClick?.(v.id); });
        const marker = new maplibregl.Marker({ element: outer }).setLngLat([v.lon, v.lat]).addTo(m);
        vm = { marker, el, lat: v.lat, lon: v.lon };
        vehMarkers.current.set(v.id, vm);
      } else glide(vm, v.lat, v.lon);
      vm.el.className = 'veh' + (v.late ? ' late' : '') + (v.dim ? ' dim' : '');
      vm.el.style.setProperty('--c', v.color);
      vm.el.innerHTML = `<i class="veh-dir" style="transform:rotate(${Math.round(v.bearing ?? 0)}deg)"></i><b>${escapeHtml(v.label)}</b>`;
    }
    for (const [id, vm] of vehMarkers.current) {
      if (seen.has(id)) continue;
      if (vm.anim) cancelAnimationFrame(vm.anim);
      vm.marker.remove();
      vehMarkers.current.delete(id);
    }
  }, [vehicles]);

  function glide(vm: VehMarker, lat: number, lon: number) {
    if (vm.anim) cancelAnimationFrame(vm.anim);
    const fromLat = vm.lat, fromLon = vm.lon;
    vm.lat = lat; vm.lon = lon;
    if (Math.abs(fromLat - lat) + Math.abs(fromLon - lon) > 0.02 || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      vm.marker.setLngLat([lon, lat]);
      return;
    }
    const t0 = performance.now(), dur = 1500;
    const step = (t: number) => {
      const f = Math.min(1, (t - t0) / dur);
      const e = f * (2 - f);
      vm.marker.setLngLat([fromLon + (lon - fromLon) * e, fromLat + (lat - fromLat) * e]);
      if (f < 1) vm.anim = requestAnimationFrame(step); else vm.anim = undefined;
    };
    vm.anim = requestAnimationFrame(step);
  }

  useEffect(() => {
    const m = map.current;
    if (follow && m && me) m.easeTo({ center: [me[1], me[0]], offset: [0, -Math.round(padRef.current / 2) + 20], duration: 800 });
  }, [follow, me]);

  useEffect(() => {
    const m = map.current;
    if (!m || !me) return;
    if (!meMarker.current) {
      const d = document.createElement('div');
      d.className = 'me';
      meMarker.current = new maplibregl.Marker({ element: d }).setLngLat([me[1], me[0]]).addTo(m);
    } else meMarker.current.setLngLat([me[1], me[0]]);
  }, [me]);

  useEffect(() => {
    if (recenterSignal && me) fitTo([me]);
  }, [recenterSignal]);

  return <div ref={el} className="map" />;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
