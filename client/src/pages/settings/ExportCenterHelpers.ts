import { TIMEZONES, DAYS } from "./ExportCenterConstants.ts";
import { NpSettings } from "./ExportCenterTypes.ts";

/**
 * Roles allowed to send the all-company export to WhatsApp. The server enforces
 * it (requireRole("Admin", "Owner") on POST /api/daily-export/trigger-whatsapp;
 * requireRole always admits Developer); the client only hides the button.
 */
export const WHATSAPP_ALL_COMPANY_EXPORT_ROLES: readonly string[] = ["Admin", "Owner", "Developer"];

export function canSendAllCompanyExportToWhatsApp(role: string | null | undefined): boolean {
  return !!role && WHATSAPP_ALL_COMPANY_EXPORT_ROLES.includes(role);
}

export function fmtBytes(bytes?: number): string {
  if (!bytes) return "—";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

export function fmtTime(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function runTypeLabel(t: string): string {
  switch (t) {
    case "scheduled":
      return "Scheduled";
    case "manual_email":
      return "Manual — Email";
    case "manual_whatsapp":
      return "Manual — WhatsApp";
    case "manual_download":
      return "Manual — Download";
    default:
      return t;
  }
}

export function runTypeBadgeClass(t: string): string {
  switch (t) {
    case "scheduled":
      return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
    case "manual_email":
      return "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300";
    case "manual_whatsapp":
      return "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300";
    case "manual_download":
      return "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300";
    default:
      return "bg-muted text-muted-foreground";
  }
}

export function fmt12h(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${h}:00 ${ampm}`;
}

export function tzLabel(tz: string): string {
  return TIMEZONES.find((t) => t.value === tz)?.label ?? tz;
}

export function formatHour(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h < 12) return `${h}:00 AM`;
  if (h === 12) return "12:00 PM";
  return `${h - 12}:00 PM`;
}

export function scheduleLabel(cfg: NpSettings | undefined): string {
  if (!cfg?.autoSend || !cfg?.enabled) return "";
  const time = formatHour(cfg.sendHour ?? 18);
  if (cfg.frequency === "daily") return `Daily at ${time} EST`;
  if (cfg.frequency === "monthly") return `Monthly (1st) at ${time} EST`;
  if (cfg.frequency === "weekly") {
    const day = DAYS.find((d) => d.value === String(cfg.sendDayOfWeek))?.label ?? "Monday";
    return `Every ${day} at ${time} EST`;
  }
  return "Auto-Send On";
}

export function currentYearDateRange() {
  const year = new Date().getFullYear();
  const today = new Date().toISOString().split("T")[0];
  return { start: `${year}-01-01`, end: today };
}
