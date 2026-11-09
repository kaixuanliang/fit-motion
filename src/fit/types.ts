export type FitValue = number | string | Array<number | string> | null;

export interface FitRecord {
  timestamp?: number;
  lat?: number;
  lon?: number;
  altitude?: number;
  speed?: number;
  distance?: number;
  heartRate?: number;
  cadence?: number;
  power?: number;
  temperature?: number;
}

export interface FitSession {
  timestamp?: number;
  startTime?: number;
  sport?: number;
  subSport?: number;
  elapsedTime?: number;
  timerTime?: number;
  distance?: number;
  calories?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgCadence?: number;
  maxCadence?: number;
  avgPower?: number;
  maxPower?: number;
  ascent?: number;
  descent?: number;
  avgAltitude?: number;
  maxAltitude?: number;
  trainingEffect?: number;
}

export interface FitLap {
  timestamp?: number;
  startTime?: number;
  elapsedTime?: number;
  timerTime?: number;
  distance?: number;
  calories?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  avgHeartRate?: number;
  maxHeartRate?: number;
  avgCadence?: number;
  maxCadence?: number;
  ascent?: number;
  descent?: number;
}

export interface ParsedFit {
  sourceType: 'fit' | 'gpx' | 'tcx';
  hasTimestamps: boolean;
  sportHint?: number;
  name?: string;
  fileType?: string;
  manufacturer?: number;
  productName?: string;
  timeCreated?: number;
  records: FitRecord[];
  sessions: FitSession[];
  laps: FitLap[];
}
