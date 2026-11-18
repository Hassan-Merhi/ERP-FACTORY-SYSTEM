// Extracted from ./ConnectivityContext.tsx
import { type ReactNode } from "react";

export type ConnectivityStatus = "online" | "offline" | "syncing" | "error";

export interface ConnectivityContextValue {
  status: ConnectivityStatus;
  isOnline: boolean;
  isSyncing: boolean;
  lastSyncedAt: number | null;
  pendingCount: number;
  failedCount: number;
  conflictCount: number;
  triggerSync: () => void;
  refreshCounts: () => Promise<void>;
}

const PING_TIMEOUT_MS = 5_000;

export async function pingServer(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const res = await fetch("/api/health", {
      credentials: "include",
      signal: controller.signal,
      cache: "no-store",
    });
    window.clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export interface Props {
  children: ReactNode;
}
