/**
 * Today's Priority Scan history, polled every second by the scanner page.
 */
import type { QueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export const PRIORITY_SCAN_HISTORY_URL =
  "/api/factory/customer-orders/loading-list/priority-scan-route?view=today-history";

export interface SessionScan {
  id: number;
  referenceNumber: string;
  productName: string | null;
  articleCode: string | null;
  orderId: number;
  priority: number;
  color: string;
  scannedBy: string | null;
  scannedAt: string;
}

export interface PriorityScanHistoryResponse {
  businessDate: string;
  serverNow: string;
  /** Identifies the scan list; sent back so an unchanged list is not re-sent. */
  signature?: string;
  scans: SessionScan[];
}

type PriorityScanHistoryPoll = Omit<PriorityScanHistoryResponse, "scans"> & {
  scans?: SessionScan[];
  unchanged?: boolean;
};

/**
 * The history is polled every second. Send back the signature of the list
 * already held; when nothing changed the server answers without the scans and
 * the held list is kept, with the fresh server time.
 */
export async function fetchPriorityScanHistory(
  client: QueryClient,
  queryKey: readonly unknown[]
): Promise<PriorityScanHistoryResponse> {
  const previous = client.getQueryData<PriorityScanHistoryResponse>(queryKey);
  const url = previous?.signature
    ? `${PRIORITY_SCAN_HISTORY_URL}&known=${encodeURIComponent(previous.signature)}`
    : PRIORITY_SCAN_HISTORY_URL;
  const response = await apiRequest("GET", url);
  const body = (await response.json()) as PriorityScanHistoryPoll;
  if (body.unchanged && previous) return { ...previous, serverNow: body.serverNow, signature: body.signature };
  return { ...body, scans: body.scans ?? [] };
}
