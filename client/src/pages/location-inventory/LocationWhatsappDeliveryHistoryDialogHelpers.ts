// Extracted from ./LocationWhatsappDeliveryHistoryDialog.tsx
import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { CheckCircle2, Clock3, XCircle } from "lucide-react";
import type { InventoryLocation } from "./locationInventoryTypes";

export interface DeliveryEntry {
  id: number;
  source: "manual" | "scheduled" | "retry";
  retryOfId: number | null;
  status: "running" | "sent" | "failed" | "skipped_empty";
  includeCost: boolean;
  includeZeroStock: boolean;
  includeNegativeStock: boolean;
  stockGroupId: number | null;
  stockGroupName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  initiatedByUserId: string | null;
  initiatedByUsername: string | null;
  scheduledFor: string | null;
  destinationGroupName: string | null;
  reportGeneratedAt: string | null;
  itemCount: number | null;
  pageCount: number | null;
  fileName: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  canRetry: boolean;
}

export interface DeliveryHistoryResponse {
  locationId: number;
  deliveries: DeliveryEntry[];
  summary: {
    latestStatus: DeliveryEntry["status"] | null;
    latestError: string | null;
    latestAt: string | null;
    lastSentAt: string | null;
    lastSentSource: DeliveryEntry["source"] | null;
    lastSentIncludeCost: boolean | null;
  };
}

export interface Props {
  location: InventoryLocation;
  companyId?: number;
  canSendWithCost: boolean;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function sourceLabel(source: DeliveryEntry["source"]): string {
  if (source === "scheduled") return "Automatic";
  if (source === "retry") return "Retry";
  return "Manual";
}

export function statusPresentation(status: DeliveryEntry["status"]) {
  if (status === "sent")
    return { label: releaseDebtEnglish("Sent"), Icon: CheckCircle2, className: "text-green-600 dark:text-green-400" };
  if (status === "failed") return { label: "Failed", Icon: XCircle, className: "text-destructive" };
  if (status === "skipped_empty")
    return {
      label: releaseDebtEnglish("No matching stock"),
      Icon: XCircle,
      className: "text-amber-600 dark:text-amber-400",
    };
  return { label: releaseDebtEnglish("Sending"), Icon: Clock3, className: "text-blue-600 dark:text-blue-400" };
}

export function newIdempotencyToken(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
