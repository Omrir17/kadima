import type { LatLon } from './geo';

export interface Place {
  lat: number;
  lon: number;
  name: string;
  stop?: number;
  code?: number;
  sub?: string;
}

export interface StopRef { stop: number; name: string; lat: number; lon: number; code: number; t: number }

export interface CarInfo {
  role: 'pickup' | 'dropoff' | 'ride';
  driveSec: number; // duration of this car leg
  driverLeaves?: number; // when the driver should leave their start point
  driverTotalSec?: number; // total driver time incl. return/detour
  detourSec?: number; // ride-along: extra minutes for the driver
  driverFrom?: Place;
  approx?: boolean;
  traffic?: boolean; // re-timed with live/predicted traffic
  warn?: string; // e.g. over the driver's limit, or risk of missing the next bus
}

export interface Leg {
  kind: 'walk' | 'transit' | 'car';
  from: Place;
  to: Place;
  dep: number;
  arr: number;
  dist?: number;
  // transit
  route?: number;
  gtfsRoute?: number;
  line?: string;
  agency?: number;
  agencyName?: string;
  rtype?: number;
  color?: string;
  headsign?: string;
  pattern?: number;
  trip?: number;
  tripRef?: number;
  board?: number;
  alight?: number;
  stops?: StopRef[];
  shape?: number;
  onBus?: boolean;
  delay?: number; // live delay in seconds (positive = late)
  // car
  car?: CarInfo;
  geometry?: LatLon[];
}

export interface Itinerary {
  id: string;
  date: string;
  legs: Leg[];
  dep: number;
  arr: number;
  transfers: number;
  walkM: number;
  cost: number;
  tags: string[];
}

export interface Prefs {
  walkSpeed: number; // m/s
  maxWalk: number; // meters (street distance) for access/egress
  slack: number; // seconds per transfer
  maxRounds: number;
}

export const DEFAULT_PREFS: Prefs = { walkSpeed: 1.25, maxWalk: 1000, slack: 90, maxRounds: 5 };

export type Mode = 'transit' | 'pickup' | 'dropoff' | 'ride' | 'onbus';

export interface BusSel {
  date: string;
  pattern: number;
  trip: number;
  nextPos: number;
  delay: number;
}

export interface PlanRequest {
  mode: Mode;
  from?: Place;
  to: Place;
  time?: number; // epoch ms; undefined = now
  arriveBy?: boolean;
  // pickup / dropoff
  driver?: Place;
  maxDriveMin?: number;
  lambda?: number; // weight of driver's minutes vs. yours
  // ride-along
  rideDest?: Place;
  detourMin?: number;
  wazeMin?: number;
  // on bus
  bus?: BusSel;
  prefs: Prefs;
  trafficKey?: string; // TomTom key, if the user set one
}

export interface PlanResponse {
  date: string;
  itineraries: Itinerary[];
  baseline?: Itinerary | null;
  note?: string;
  approx?: boolean;
  traffic?: 'on' | 'off' | string; // 'on' = car legs include traffic; other string = error message
}

export interface BusCandidate {
  date: string;
  pattern: number;
  trip: number;
  route: number;
  gtfsRoute: number;
  line: string;
  agencyName: string;
  headsign: string;
  to: string;
  nextPos: number;
  nextStopName: string;
  distM: number;
  delay: number;
  live: boolean;
  schedAtNext: number;
  color: string;
}

export interface Departure {
  pattern: number;
  trip: number;
  tripRef: number;
  pos: number;
  time: number;
  sched: number;
  live: boolean;
  route: number;
  gtfsRoute: number;
  line: string;
  rtype: number;
  agency: number;
  headsign: string;
  color: string;
}

export interface LineVariant {
  route: number;
  gtfsRoute: number;
  line: string;
  agencyName: string;
  agency: number;
  rtype: number;
  from: string;
  to: string;
  patterns: number[];
  color: string;
}

export interface VehicleView {
  lat: number;
  lon: number;
  bearing: number;
  line: string;
  color: string;
  delay?: number;
  ageSec: number;
  tripRef: number;
}
