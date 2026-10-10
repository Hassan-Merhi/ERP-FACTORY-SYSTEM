import { resolvePriorityLabelColor, type LabelData } from "./labelHtml";

export const PRIORITY_PRINT_BATCH_URL = "/api/factory/customer-orders/loading-list/automatic-print-preflight-batch";

/** Must match the route's per-request limit. */
export const PRIORITY_PRINT_BATCH_LIMIT = 200;

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
export type PriorityPrintCandidate = { baleId: number } | { referenceNumber: string };
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
  // A physical bale ID is authoritative. Some screens print a fallback code
  // when a bale has no stored reference, so never send that label text as a
  // reference to be cross-checked against the ID.
  const items: PriorityPrintCandidate[] = labels.map((label, index) =>
    baleIds?.[index] != null ? { baleId: baleIds[index] } : { referenceNumber: label.referenceNumber }
  );

  const byId = new Map<number, PriorityPrintRow>();
  const byRef = new Map<string, PriorityPrintRow>();
  // The server caps one atomic preflight at PRIORITY_PRINT_BATCH_LIMIT bales.
  // Larger "select all" prints are prepared in consecutive atomic chunks; a
  // failing chunk stops the whole print before any window is rendered.
  for (let offset = 0; offset < items.length; offset += PRIORITY_PRINT_BATCH_LIMIT) {
    const chunk = items.slice(offset, offset + PRIORITY_PRINT_BATCH_LIMIT);
    const response = await request("POST", PRIORITY_PRINT_BATCH_URL, { items: chunk });
    if (!response.ok) {
      const error = await response.json().catch(() => null);
      throw new Error(typeof error?.message === "string" ? error.message : "Could not prepare priority labels");
    }
    const body = (await response.json()) as { results?: PriorityPrintRow[] };
    if (!Array.isArray(body.results)) throw new Error("Incomplete priority print response");
    for (const row of body.results) {
      if (!row || !Number.isSafeInteger(row.baleId) || typeof row.referenceNumber !== "string") {
        throw new Error("Invalid priority print response");
      }
      byId.set(row.baleId, row);
      byRef.set(row.referenceNumber.toLowerCase(), row);
    }
  }

  return labels.map((label, index) => {
    const byBaleId = baleIds?.[index] != null;
    const matched = byBaleId ? byId.get(baleIds[index]!) : byRef.get(label.referenceNumber.toLowerCase());
    if (!matched || (!byBaleId && matched.referenceNumber.toLowerCase() !== label.referenceNumber.toLowerCase())) {
      throw new Error(`Priority preparation missing bale ${label.referenceNumber}`);
    }
    const assignment = matched.priorityAllocation;
    if (!assignment) {
      if (label.priorityColor) {
        throw new Error(`Bale ${label.referenceNumber} is no longer allocated. Refresh before printing.`);
      }
      return { ...label, priorityColor: undefined, priorityOrderId: null, priorityNumber: null };
    }
    if (assignment.baleId !== matched.baleId || !resolvePriorityLabelColor(assignment.color)) {
      throw new Error(`Invalid priority assignment for ${label.referenceNumber}`);
    }
    if (label.priorityOrderId && label.priorityOrderId !== assignment.orderId) {
      throw new Error(`Loading changed for ${label.referenceNumber}. Refresh before printing.`);
    }
    if (
      label.priorityColor &&
      resolvePriorityLabelColor(label.priorityColor) !== resolvePriorityLabelColor(assignment.color)
    ) {
      throw new Error(`Priority color changed for ${label.referenceNumber}. Refresh before printing.`);
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
export function withRecordedPriorityAllocations<T extends LabelData>(
  labels: T[],
  baleIds: number[],
  allocations: PriorityPrintAssignment[]
): T[] {
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

/**
 * The per-bale reprint audit endpoint resolves the assignment again. If a
 * priority loading became eligible between the preflight and the audit call,
 * the label prepared earlier would be stale: fail closed instead of printing
 * an ordinary label for a bale that is now allocated (or vice versa).
 */
export async function assertReprintMatchesPrepared(response: Response, label: LabelData): Promise<void> {
  if (!response.ok) throw new Error("Could not record label reprint");
  const body = (await response.json().catch(() => null)) as {
    priorityAllocation?: { orderId?: number | null; color?: string | null } | null;
  } | null;
  if (!body || !Object.prototype.hasOwnProperty.call(body, "priorityAllocation")) {
    throw new Error(`Incomplete priority reprint audit for ${label.referenceNumber}.`);
  }
  const recordedOrderId = body.priorityAllocation?.orderId ?? null;
  if (recordedOrderId !== (label.priorityOrderId ?? null)) {
    throw new Error(`Loading changed for ${label.referenceNumber}. Refresh before printing.`);
  }
  const savedColor = resolvePriorityLabelColor(label.priorityColor);
  const recordedColor = resolvePriorityLabelColor(body.priorityAllocation?.color);
  if (
    (label.priorityColor && !savedColor) ||
    (body.priorityAllocation?.color && !recordedColor) ||
    savedColor !== recordedColor
  ) {
    throw new Error(`Priority color changed for ${label.referenceNumber}. Refresh before printing.`);
  }
}
