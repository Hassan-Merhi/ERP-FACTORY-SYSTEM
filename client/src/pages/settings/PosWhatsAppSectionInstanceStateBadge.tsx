// Extracted from ./PosWhatsAppSection.tsx to keep that module under the source-size cap.
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, Loader2, Moon, XCircle } from "lucide-react";

export interface Location {
  id: number;
  name: string;
  whatsappGroupChatId?: string | null;
}

export interface WaChat {
  id: string;
  name: string;
  type: string;
}

export interface PosInstanceSettings {
  instanceId: string;
  apiToken: string;
  enabled: boolean;
  hasCredentials: boolean;
}

export type InstanceState =
  | "authorized"
  | "notAuthorized"
  | "sleepMode"
  | "starting"
  | "yellowCard"
  | "blocked"
  | "suspended"
  | "invalidCredentials"
  | "notConfigured"
  | "unknown";

export function InstanceStateBadge({ state, loading }: { state: InstanceState | undefined; loading: boolean }) {
  if (loading) {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-instance-state">
        <Loader2 className="h-3 w-3 animate-spin" />
        Checking…
      </Badge>
    );
  }
  if (!state) return null;
  if (state === "authorized") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-green-700 bg-green-100 dark:bg-green-950 dark:text-green-300"
        data-testid="badge-instance-state"
      >
        <CheckCircle className="h-3 w-3" />
        Authorized
      </Badge>
    );
  }
  if (state === "sleepMode") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-amber-700 bg-amber-100 dark:bg-amber-950 dark:text-amber-300"
        data-testid="badge-instance-state"
      >
        <Moon className="h-3 w-3" />
        Sleeping — messages won't send
      </Badge>
    );
  }
  if (state === "notAuthorized") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300"
        data-testid="badge-instance-state"
      >
        <XCircle className="h-3 w-3" />
        Not authorized — scan QR code
      </Badge>
    );
  }
  if (state === "blocked" || state === "suspended" || state === "invalidCredentials") {
    const label = {
      blocked: "WhatsApp blocked",
      suspended: "Sending suspended",
      invalidCredentials: "Invalid API credentials",
    }[state];
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-red-700 bg-red-100 dark:bg-red-950 dark:text-red-300"
        data-testid="badge-instance-state"
      >
        <XCircle className="h-3 w-3" />
        {label}
      </Badge>
    );
  }
  if (state === "yellowCard") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-orange-700 bg-orange-100 dark:bg-orange-950 dark:text-orange-300"
        data-testid="badge-instance-state"
      >
        <AlertTriangle className="h-3 w-3" />
        Warning — account at risk
      </Badge>
    );
  }
  if (state === "starting") {
    return (
      <Badge
        variant="secondary"
        className="gap-1 text-blue-700 bg-blue-100 dark:bg-blue-950 dark:text-blue-300"
        data-testid="badge-instance-state"
      >
        <Loader2 className="h-3 w-3 animate-spin" />
        Starting up…
      </Badge>
    );
  }
  if (state === "notConfigured") {
    return (
      <Badge variant="secondary" className="gap-1" data-testid="badge-instance-state">
        <XCircle className="h-3 w-3 text-muted-foreground" />
        Not configured
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="gap-1" data-testid="badge-instance-state">
      <XCircle className="h-3 w-3 text-muted-foreground" />
      Unknown
    </Badge>
  );
}
