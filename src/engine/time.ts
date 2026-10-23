// All schedule times are "seconds since midnight of the service day" in Israel local time.
const TZ = 'Asia/Jerusalem';

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function israelParts(ms: number) {
  const p: Record<string, string> = {};
  for (const x of fmt.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    ymd: `${p.year}-${p.month}-${p.day}`,
    sec: (+p.hour) * 3600 + (+p.minute) * 60 + (+p.second),
    weekday: new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`).getUTCDay(),
    hour: +p.hour,
  };
}

export function israelNow() {
  return israelParts(Date.now());
}

export function addDays(ymd: string, n: number) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Converts an epoch ms timestamp to seconds relative to the midnight of the given service day. */
export function epochToDaySec(ms: number, ymd: string) {
  const p = israelParts(ms);
  if (p.ymd === ymd) return p.sec;
  const diffDays = Math.round((Date.parse(p.ymd + 'T12:00:00Z') - Date.parse(ymd + 'T12:00:00Z')) / 86400000);
  return p.sec + diffDays * 86400;
}

/** Epoch ms of a service-day second (approx, uses the current offset). */
export function daySecToEpoch(sec: number, ymd: string) {
  const now = Date.now();
  return now + (sec - epochToDaySec(now, ymd)) * 1000;
}

export function hm(sec: number) {
  sec = Math.round(sec / 60) * 60;
  let h = Math.floor(sec / 3600) % 24;
  if (h < 0) h += 24;
  const m = Math.floor((sec % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String((m + 60) % 60).padStart(2, '0')}`;
}

export function mins(sec: number) {
  return Math.max(0, Math.round(sec / 60));
}

export function durText(sec: number) {
  const m = mins(sec);
  if (m < 60) return `${m} דק'`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} ש' ${r} דק'` : `${h} ש'`;
}

/** Rough traffic multiplier over free-flow driving times, by Israeli weekday/hour. */
export function trafficFactor(ms: number) {
  const { weekday, hour } = israelParts(ms);
  const h = hour;
  if (weekday === 6) return h >= 9 && h < 20 ? 1.15 : 1.05; // Saturday
  if (weekday === 5) return h >= 9 && h < 15 ? 1.3 : 1.1; // Friday
  if (h >= 7 && h < 10) return 1.6;
  if (h >= 15 && h < 19) return 1.55;
  if (h >= 10 && h < 15) return 1.3;
  if (h >= 19 && h < 21) return 1.2;
  return 1.05;
}
