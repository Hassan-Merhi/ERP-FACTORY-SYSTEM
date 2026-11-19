// Extracted from ./buildWeeklyProductionData.ts
import { type ProductionResponse } from "../factoryProductionTargetsModel";

export interface ProductionReportDay {
  date: string;
  snapshot: ProductionResponse;
}

export interface DailyTeamRecord {
  date: string;
  category: string;
  people: string;
  codes: string;
  team: string;
  target: number | null;
  absentTarget: number;
  expected: number;
  produced: number;
  difference: number;
  attendance: string;
  creditedBreakdown: string;
  dayStatus: string;
}

export interface WorkerDayRecord {
  date: string;
  workerId: number;
  name: string;
  code: string;
  category: string;
  linkedWith: string;
  team: string;
  target: number | null;
  status: string;
  soloProduced: number;
  linkedProduced: number;
  totalProduced: number;
  sharedTeamProduced: number | null;
  dayStatus: string;
}
