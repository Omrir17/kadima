import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 22): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
});

export const IconWalk = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="13" cy="4" r="1.6" /><path d="M10 21l2-6 2.5 2.5V21M8.5 11l2-3.5 3 1.5 1.5 3 2.5 1M12 15l-1.5-4" /></svg>
);
export const IconBus = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="4" y="3" width="16" height="15" rx="3" /><path d="M4 11h16M8 18v2.5M16 18v2.5" /><circle cx="8" cy="14.5" r=".9" fill="currentColor" /><circle cx="16" cy="14.5" r=".9" fill="currentColor" /></svg>
);
export const IconTrain = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="5" y="3" width="14" height="14" rx="4" /><path d="M5 10h14M8 21l2-4M16 21l-2-4" /><circle cx="9" cy="13.5" r=".9" fill="currentColor" /><circle cx="15" cy="13.5" r=".9" fill="currentColor" /></svg>
);
export const IconTram = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="6" y="6" width="12" height="12" rx="3" /><path d="M12 6V3M9 3h6M6 13h12M9 21l1.5-3M15 21l-1.5-3" /></svg>
);
export const IconCar = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M5 16V12l2-5h10l2 5v4" /><path d="M3 16h18v3H3z" /><circle cx="7.5" cy="19" r="1.5" /><circle cx="16.5" cy="19" r="1.5" /><path d="M5 12h14" /></svg>
);
export const IconThumb = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M7 11v9H4v-9zM7 11l4-7c1.5 0 2.5 1 2.2 2.6L12.6 10H19a2 2 0 012 2.3l-1.2 6A2 2 0 0117.8 20H7" /></svg>
);
export const IconPickup = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 21s-6-5.3-6-10a6 6 0 0112 0c0 4.7-6 10-6 10z" /><path d="M9 11.5l1-2.5h4l1 2.5v2H9z" /></svg>
);
export const IconDropoff = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 15v-3l2-4h8l2 4v3H3z" /><circle cx="6" cy="16" r="1.4" /><circle cx="12" cy="16" r="1.4" /><path d="M18 6v14M18 6h3.5l-1 2 1 2H18" /></svg>
);
export const IconHome = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5" /><path d="M10 20v-5h4v5" /></svg>
);
export const IconWork = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2M3 13h18" /></svg>
);
export const IconStar = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></svg>
);
export const IconSearch = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>
);
export const IconSwap = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M8 4v16M8 4L5 7M8 4l3 3M16 20V4M16 20l-3-3M16 20l3-3" /></svg>
);
export const IconBack = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M9 5l7 7-7 7" /></svg>
);
export const IconClose = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
export const IconGear = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z" /></svg>
);
export const IconLocate = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></svg>
);
export const IconPin = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0113 0c0 5.4-6.5 11-6.5 11z" /><circle cx="12" cy="10" r="2.3" /></svg>
);
export const IconClock = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
);
export const IconShare = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M12 15V3M8 7l4-4 4 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" /></svg>
);
export const IconNav = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M3 11l18-8-8 18-2-8z" /></svg>
);
export const IconRoute = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><circle cx="6" cy="19" r="2.5" /><circle cx="18" cy="5" r="2.5" /><path d="M8.5 19H16a3.5 3.5 0 000-7H8a3.5 3.5 0 010-7h7.5" /></svg>
);
export const IconChevron = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M15 6l-6 6 6 6" /></svg>
);
export const IconMap = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M9 4L3 6.5v13.5L9 17.5l6 2.5 6-2.5V4L15 6.5z" /><path d="M9 4v13.5M15 6.5V20" /></svg>
);
export const IconWhatsapp = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}><path d="M4 20l1.3-4A8 8 0 1112 20a8 8 0 01-3.9-1z" /><path d="M9 9.5c0 2.8 2.7 5.5 5.5 5.5l1-1.3-1.8-1-.9.8a4 4 0 01-2.3-2.3l.8-.9-1-1.8z" /></svg>
);

export function ModeIcon({ rtype, size }: { rtype?: number; size?: number }) {
  if (rtype === 2) return <IconTrain size={size} />;
  if (rtype === 0) return <IconTram size={size} />;
  return <IconBus size={size} />;
}
