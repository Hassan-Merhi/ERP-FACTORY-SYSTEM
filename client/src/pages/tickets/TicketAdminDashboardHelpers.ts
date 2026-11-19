// Extracted from ./TicketAdminDashboard.tsx

export type ReportFilters = {
  from: string;
  to: string;
  status: string;
  priority: string;
  sourceMode: string;
  category: string;
  assignedTo: string;
};

type Summary = {
  total: string;
  open: string;
  seen: string;
  working: string;
  reopened: string;
  finalized: string;
  overdue: string;
  urgent: string;
  avg_resolution_hours: string | null;
  resolved_within_24_hours: string;
};

type Group = { label: string; count: string; overdue: string };

type Employee = {
  user_id: string;
  username: string | null;
  count: string;
  finalized: string;
  overdue: string;
  avg_resolution_hours: string | null;
};

type Day = { day: string; created: string; finalized: string };

type OverdueCase = {
  id: number;
  ticket_number: string;
  title: string;
  assigned_to: string;
  username: string | null;
  status: string;
  priority: string;
  due_at: string;
  overdue_hours: string;
};

export type Report = {
  summary: Summary;
  byStatus: Group[];
  byCategory: Group[];
  byEmployee: Employee[];
  byCreatedDay: Day[];
  overdueCases: OverdueCase[];
  generatedAt: string;
};

export const initial: ReportFilters = {
  from: "",
  to: "",
  status: "",
  priority: "",
  sourceMode: "",
  category: "",
  assignedTo: "",
};

export function queryString(filters: ReportFilters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
  return params.toString();
}

export function safeNumber(value: string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}
