// Extracted from ./useNotificationsCenterState.ts

export interface NotificationItem {
  id: number;
  eventType: string;
  title: string;
  message: string;
  entityType: string | null;
  entityId: number | null;
  triggeredByUserId: string | null;
  triggeredByUsername: string | null;
  companyId: number | null;
  companyName: string | null;
  isRead: boolean;
  readAt: string | null;
  createdAt: string;
}

export interface ICRequest {
  id: number;
  fromCompanyName: string;
  destCompanyName: string;
  destCompanyId: number;
  fromVoucherNumber: string;
  fromVoucherDate: string;
  amount: string;
  description: string | null;
  status: string;
  createdAt: string;
  approvedByUsername: string | null;
  approvedAt: string | null;
  dismissNote: string | null;
  linkDestLedgerAccountId: number;
  linkDestLedgerName: string;
  chosenAccountName: string | null;
  destVoucherId: number | null;
}

export interface LedgerAccount {
  id: number;
  name: string;
  companyId: number;
}

export type TabId = "all" | "loading" | "invoice" | "intercompany";
