// Extracted from ./PressingCorrectionReview.tsx
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";

export const ROOT = "/api/factory/pressing-machines";

export type CorrectionEvent = {
  id: number;
  companyId: number;
  confirmationId: number;
  replacementConfirmationId: number | null;
  action: "VOID" | "RECONFIRM";
  reason: string;
  supervisorUserId: string;
  supervisorDisplayName?: string;
  createdAt: string;
};

export function dateTime(raw: string): string {
  return new Date(raw).toLocaleString("en-GB", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: PRESSING_TIME_ZONE,
  });
}
