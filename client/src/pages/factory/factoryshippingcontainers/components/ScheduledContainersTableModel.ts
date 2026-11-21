// Extracted from ./ScheduledContainersTable.tsx

export interface ScheduledRow {
  id: number;
  date: string;
  shippingCompany: string;
  scheduledContainers: number;
  note: string | null;
  details: string | null;
  isArchived: boolean;
  archivedAt: string | null;
}

export interface EditingScheduled {
  id: number;
  date: string;
  shippingCompany: string;
  scheduledContainers: string;
  note: string;
  details: string;
}

export const SCHEDULED_KEY = "/api/factory/scheduled-containers";
