// Extracted from ./StockReportSection.tsx

export interface Company {
  id: number;
  name: string;
}

export interface Recipient {
  id: number;
  chatId: string;
  name: string;
  isGroup: boolean;
  active: boolean;
}

export interface StockSettings {
  companyId: number | null;
  recipientId: number | null;
  autoSend: boolean;
  enabled: boolean;
  frequency: string;
  sendHour: number;
  sendDayOfWeek: number;
  lastSentAt: string | null;
}

export const DAYS = [
  { value: "0", label: "Sunday" },
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
];

export function formatHour(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}

export function scheduleLabel(cfg: StockSettings | undefined): string {
  if (!cfg?.autoSend) return "";
  const time = formatHour(cfg.sendHour ?? 18);
  if (cfg.frequency === "daily") return `Daily at ${time} EST`;
  if (cfg.frequency === "monthly") return `Monthly (1st) at ${time} EST`;
  if (cfg.frequency === "weekly") {
    const day = DAYS.find((d) => d.value === String(cfg.sendDayOfWeek))?.label ?? "Monday";
    return `Every ${day} at ${time} EST`;
  }
  return "Auto-Send On";
}
