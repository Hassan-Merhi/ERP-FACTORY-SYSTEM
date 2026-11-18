// Extracted from ./performanceDashboard.ts

export interface RequestSample {
  timestamp: number;
  method: string;
  routeTemplate: string;
  mode: string;
  status: number;
  durationMs: number;
  responseBytes: number;
  dbQueryCount: number;
  dbDurationMs: number;
}

export interface RouteAggregate {
  method: string;
  route: string;
  mode: string;
  count: number;
  errors: number;
  clientAborts: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
  dbMs: number;
  dbQueries: number;
  durations: number[];
}
