/** Verify original supplier PO rows and destination ERP PO rows before any physical receipt. */
import { MoneyDecimal } from "../../lib/money";

type PurchaseLine = {
  id: number;
  itemName: string;
  quantity: string;
  rate: string;
  lineTotal: string;
};
type LinkedLine = { sourceLineId: number; destinationLineId: number };

export function assertPhase5MirroredLines(
  sourceLines: readonly PurchaseLine[],
  destinationLines: readonly PurchaseLine[],
  links: readonly LinkedLine[]
): void {
  if (!links.length || sourceLines.length !== links.length || destinationLines.length !== links.length) {
    throw new Error("Linked source/destination PO lines are incomplete");
  }
  const source = new Map(sourceLines.map((line) => [line.id, line]));
  const destination = new Map(destinationLines.map((line) => [line.id, line]));
  const sourceSeen = new Set<number>();
  const destinationSeen = new Set<number>();
  for (const link of links) {
    const a = source.get(link.sourceLineId);
    const b = destination.get(link.destinationLineId);
    if (!a || !b || sourceSeen.has(link.sourceLineId) || destinationSeen.has(link.destinationLineId)) {
      throw new Error("Every linked PO row must be paired exactly once");
    }
    sourceSeen.add(link.sourceLineId);
    destinationSeen.add(link.destinationLineId);
    // The original and destination stock IDs can differ by company, but
    // the linked purchase description must still identify the same goods.
    const originalName = a.itemName.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    const destinationName = b.itemName.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (!originalName || originalName !== destinationName) {
      throw new Error("Source and ERP destination purchase rows disagree on item name");
    }
    for (const field of ["quantity", "rate", "lineTotal"] as const) {
      const left = new MoneyDecimal(a[field]);
      const right = new MoneyDecimal(b[field]);
      if (!left.isFinite() || !right.isFinite() || !left.eq(right)) {
        throw new Error("Source and ERP destination purchase rows disagree on " + field);
      }
    }
  }
}
