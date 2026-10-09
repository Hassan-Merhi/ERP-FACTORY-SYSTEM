import type { LabelData } from "./labelHtml";

export const PRIORITY_PRINT_BATCH_URL =
  "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch";

export type PrintRequest = (method: string, url: string, body?: unknown) => Promise<Response>;

export interface PriorityPrintAssignment {
  baleId: number;
  referenceNumber: string;
  orderId: number;
  priority: number;
  color: string;
  existing: boolean;
  source: string;
}
export interface PriorityPrintCandidate {
  baleId?: number;
  referenceNumber: string;
}
interface PriorityPrintRow {
  baleId: number;
  referenceNumber: string;
  priorityAllocation: PriorityPrintAssignment | null;
}

/**
 * All specialist print surfaces use one authoritative batch preflight.
 *
 * This is deliberately not a dry run: an eligible unallocated bale is loaded
 * into its priority destination, exactly as when it is printed from Stock Entry.
 * Reprints of allocated bales keep the original stored color and order ID.
 *
 * Fail CLOSED before opening any printer window if the response is incomplete,
 * missing an item, or contradicts an earlier server-provided assignment.
 */
export async function preparePriorityPrintLabels(
  labels: LabelData[],
  request: PrintRequest,
  baleIds?: Array<number | undefined>
): Promise<LabelData[]> {
  if (labels.length === 0) return [];
  const items: PriorityPrintCandidate[] = labels.map((label, index) => ({
    referenceNumber: label.referenceNumber,
    ...(baleIds?.[index] != null ? { baleId: baleIds[index] } : {}),
  }));
  const response = await request("POST", PRIORITY_PRINT_BATCH_URL, { items });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(
      typeof error?.message === "string" ? error.message : "Could not prepare priority labels"
    );
  }
  const body = (await response.json()) as { results?: PriorityPrintRow[] };
  if (!Array.isArray(body.results)) throw new Error("Incomplete priority print response");

  const byId = new Map<number, PriorityPrintRow>();
  const byRef = new Map<string, PriorityPrintRow>();
  for (const row of body.results) {
    if (!row || !Number.isSafeInteger(row.baleId) ||
        typeof row.referenceNumber !== "string") {
      throw new Error("Invalid priority print response");
    }
    byId.set(row.baleId, row);
    byRef.set(row.referenceNumber.toLowerCase(), row);
  }

  return labels.map((label, index) => {
    const matched = baleIds?.[index] != null
      ? byId.get(baleIds[index]!)
      : byRef.get(label.referenceNumber.toLowerCase());
    if (!matched || matched.referenceNumber.toLowerCase() !== label.referenceNumber.toLowerCase()) {
      throw new Error(`Priority preparation missing bale ${label.referenceNumber}`);
    }
    const assignment = matched.priorityAllocation;
    if (!assignment) {
      if (label.priorityColor) {
        throw new Error(`Bale ${label.referenceNumber} is no longer allocated. Refresh before printing.`);
      }
      return { ...label, priorityColor: undefined, priorityOrderId: null, priorityNumber: null };
    }
    if (assignment.baleId !== matched.baleId || !assignment.color) {
      throw new Error(`Invalid priority assignment for ${label.referenceNumber}`);
    }
    if (label.priorityOrderId && label.priorityOrderId !== assignment.orderId) {
      throw new Error(`Loading changed for ${label.referenceNumber}. Refresh before printing.`);
    }
    return {
      ...label,
      priorityColor: assignment.color,
      priorityOrderId: assignment.orderId,
      priorityNumber: assignment.priority,
    };
  });
}

/** Apply snapshots already returned by a label-print audit endpoint.
 *  Missing snapshots mean ordinary label printing, never a guessed color.
 */
export function withRecordedPriorityAllocations(
  labels: LabelData[],
  baleIds: number[],
  allocations: PriorityPrintAssignment[]
): LabelData[] {
  const byBale = new Map(allocations.map((a) => [a.baleId, a]));
  return labels.map((label, index) => {
    const assignment = byBale.get(baleIds[index]);
    return assignment
      ? {
          ...label,
          priorityColor: assignment.color,
          priorityOrderId: assignment.orderId,
          priorityNumber: assignment.priority,
        }
      : label;
  });
}
