import { AlertTriangle, AlertCircle, CheckCircle2 } from "lucide-react";

export type Status = "OTW" | "Sea" | "At Port" | "Left Dar" | "At Border" | "In Transit" | "Arrived" | "Offloaded";

export const STATUS_BADGE: Record<Status, string> = {
  OTW: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  Sea: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  "At Port": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "Left Dar": "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  "At Border": "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  "In Transit": "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  Arrived: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  Offloaded: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

export type CompanyViewMode = "session" | "all";

export interface EnrichedContainerApi {
  id: number;
  companyId: number;
  companyName: string;
  containerNumber: string;
  supplierId: number;
  supplierName: string | null;
  supplierCode: string | null;
  status: string;
  importDate: string;
  grandTotal: string | null;
  itemName: string | null;
  shopName: string | null;
  eta: string | null;
  etaSource: string | null;
  transporter: string | null;
  transportFee: string | null;
  numberPlate: string | null;
  trackingLocation: string | null;
  borderDate: string | null;
  offloadDate: string | null;
  agent: string | null;
  dutyFee: string | null;
  docReceived: boolean | null;
  trackingDescription: string | null;
  docsSentDate: string | null;
  freightStatus: string | null;
  trackingLink: string | null;
  maxOffloadDate: string | null;
  daysDelayed: number | null;
  docsReadyNotSent: boolean;
  isOverdue: boolean;
}

export interface GitContainersSingle {
  asOf: string;
  mode: "single";
  companyId: number;
  companyName: string;
  total: number;
  containers: EnrichedContainerApi[];
}

export interface GitContainersAll {
  asOf: string;
  mode: "all";
  total: number;
  containers: EnrichedContainerApi[];
}

export type GitContainersResponse = GitContainersSingle | GitContainersAll;

export type WarningCode =
  | "no_open_balance"
  | "ledger_exceeds_containers"
  | "allocation_gap"
  | "fuzzy_match"
  | "no_account_linked";

export type ApiAllocStatus = "Cleared" | "Partially Cleared" | "Open";

export interface ApiAllocatedRow {
  id: number;
  containerNumber: string;
  companyId: number;
  numberPlate: string | null;
  offloadDate: string | null;
  borderDate: string | null;
  transporter: string | null;
  location: string | null;
  dutyFee: number;
  status: string;
  clearedAmount: number;
  remainingAmount: number;
  allocationStatus: ApiAllocStatus;
  supplierName: string | null;
  supplierCode: string | null;
}

export interface ApiPreviewRow {
  id: number;
  containerNumber: string;
  companyId: number;
  numberPlate: string | null;
  borderDate: string | null;
  transporter: string | null;
  location: string | null;
  dutyFee: number;
  status: string;
  supplierName: string | null;
  supplierCode: string | null;
}

export interface AgentDutySummary {
  agentName: string;
  ledgerAccountId: number | null;
  ledgerAccountName: string | null;
  matchConfidence: "exact" | "fuzzy" | "unmapped";
  ledgerBalance: number | null;
  containerDutyTotal: number;
  offloadedDutyTotal: number;
  clearedByPayments: number;
  openBalance: number | null;
  warnings: WarningCode[];
  clearedRows: ApiAllocatedRow[];
  partialRows: ApiAllocatedRow[];
  openRows: ApiAllocatedRow[];
  activePreviewRows: ApiPreviewRow[];
}

export interface AgentDutyCompanySection {
  companyId: number;
  companyName: string;
  agents: AgentDutySummary[];
}

export interface AgentDutyResponseSingle {
  asOf: string;
  mode: "single";
  companyId: number;
  companyName: string;
  agents: AgentDutySummary[];
}

export interface AgentDutyResponseAll {
  asOf: string;
  mode: "all";
  companies: AgentDutyCompanySection[];
}

export type AgentDutyResponse = AgentDutyResponseSingle | AgentDutyResponseAll;

export interface AgentDutyWaSettings {
  groups: Record<string, string>;
  hasCredentials: boolean;
  waEnabled: boolean;
}

export const WARNING_META: Record<
  WarningCode,
  {
    icon: typeof AlertTriangle;
    className: string;
    message: string;
  }
> = {
  fuzzy_match: {
    icon: AlertTriangle,
    className:
      "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300",
    message:
      "Account linked by fuzzy name match — verify the ledger account is correct. Add an exact mapping in Agent Mappings to suppress this warning.",
  },
  no_account_linked: {
    icon: AlertCircle,
    className: "bg-muted/50 border-border text-muted-foreground",
    message:
      "No ledger account linked to this agent. Balance shown as unavailable. Add a mapping in Agent Mappings to enable balance tracking.",
  },
  ledger_exceeds_containers: {
    icon: AlertTriangle,
    className:
      "bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300",
    message:
      "Ledger balance exceeds total offloaded duty — there may be payments not matched to any container in this list.",
  },
  allocation_gap: {
    icon: AlertTriangle,
    className: "bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800 text-red-800 dark:text-red-300",
    message:
      "Allocation gap detected — the sum of open remaining amounts does not match the account balance. Check for missing or duplicate container rows.",
  },
  no_open_balance: {
    icon: CheckCircle2,
    className:
      "bg-green-50 dark:bg-green-950/20 border-green-200 dark:border-green-800 text-green-800 dark:text-green-300",
    message: "Account balance is zero — all offloaded containers are fully cleared by payments.",
  },
};
