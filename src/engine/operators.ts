const AGENCY_COLORS: Record<number, string> = {
  2: '#2a4b8d', // Israel Railways
  3: '#1f8a3b', // Egged
  4: '#d6322f', // Electra Afikim
  25: '#d6322f',
  5: '#1d5fbf', // Dan
  31: '#1d5fbf',
  32: '#1d5fbf',
  39: '#1d5fbf',
  14: '#2b7bb9', // Nativ Express
  15: '#ec6a1c', // Metropoline
  16: '#e0a100', // Superbus
  18: '#d4145a', // Kavim
  21: '#c8102e', // CFIR (Jerusalem LRT)
  22: '#00877a', // Tevel
  23: '#0097d7', // Galim
  34: '#6d2c91', // Tnufa
  37: '#f08c00', // Extra
  38: '#f08c00',
  35: '#5b8c2a',
  20: '#555555',
};

export function lineColor(agency: number, rtype: number, routeColor: string) {
  if (routeColor && /^[0-9a-f]{6}$/i.test(routeColor) && routeColor.toUpperCase() !== 'FFFFFF') return '#' + routeColor;
  if (rtype === 2) return AGENCY_COLORS[2];
  return AGENCY_COLORS[agency] || '#5a6b7d';
}

export function modeName(rtype: number) {
  switch (rtype) {
    case 0: return 'רכבת קלה';
    case 2: return 'רכבת';
    case 5: case 8: return 'כרמלית/רכבל';
    case 715: return 'קו גמיש';
    default: return 'אוטובוס';
  }
}
