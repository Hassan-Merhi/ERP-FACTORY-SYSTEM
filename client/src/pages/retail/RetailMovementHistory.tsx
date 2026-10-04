import { useQuery } from "@tanstack/react-query";
import { getJson } from "./retailInventoryTypes";

export interface RetailMovementRow {
  id: number;
  movementType: string;
  locationName: string | null;
  quantityDelta: number;
  quantityBefore: number;
  quantityAfter: number;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  counterpartLocation: string | null;
  createdAt: string;
  createdBy: string | null;
}

const MOVEMENT_LABELS: Record<string, string> = {
  sale: "Sale",
  return: "Return",
  receive: "Received",
  transfer_out: "Transfer out",
  transfer_in: "Transfer in",
  adjustment: "Adjustment",
  import: "Import",
  cancellation: "Sale canceled",
  reversal: "Reversal",
};

/** Append-only movement trail for one exact variant (newest first). */
export function RetailMovementHistory({ variantId, companyKey }: { variantId: number; companyKey: number }) {
  const { data = [], isLoading } = useQuery<RetailMovementRow[]>({
    queryKey: ["retail-variant-movements", companyKey, variantId],
    queryFn: () => getJson(`/api/retail/variants/${variantId}/movements`),
    enabled: variantId > 0,
  });
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading history…</p>;
  if (!data.length) return <p className="text-sm text-muted-foreground">No stock movements yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm [&_td]:px-1.5 [&_th]:px-1.5">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2">Date</th>
            <th>Movement</th>
            <th>Location</th>
            <th className="text-right">Before</th>
            <th className="text-right">Change</th>
            <th className="text-right">After</th>
            <th>User</th>
            <th>Reason / reference</th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.id} className="border-b last:border-0" data-testid="movement-row">
              <td className="py-2 whitespace-nowrap">{new Date(row.createdAt).toLocaleString()}</td>
              <td data-i18n-ui>{MOVEMENT_LABELS[row.movementType] ?? row.movementType}</td>
              <td>
                {row.locationName ?? "—"}
                {row.counterpartLocation && (
                  <span className="text-muted-foreground">
                    {row.movementType === "transfer_out" ? " → " : " ← "}
                    {row.counterpartLocation}
                  </span>
                )}
              </td>
              <td className="text-right">{row.quantityBefore}</td>
              <td
                className={`text-right font-medium ${row.quantityDelta < 0 ? "text-destructive" : "text-emerald-600"}`}
              >
                {row.quantityDelta > 0 ? `+${row.quantityDelta}` : row.quantityDelta}
              </td>
              <td className="text-right">{row.quantityAfter}</td>
              <td>{row.createdBy ?? "—"}</td>
              <td className="max-w-[220px] truncate">
                {row.reason ?? ""}
                {row.referenceType ? (
                  <span className="text-muted-foreground">
                    {row.reason ? " · " : ""}
                    {row.referenceType.replace(/^retail_/, "")} #{row.referenceId}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface RetailLabelEvent {
  id: number;
  barcode: string;
  copies: number;
  layout: string;
  isReprint: boolean;
  createdAt: string;
  createdBy: string | null;
}

/** Barcode label print / reprint audit for one variant. */
export function RetailLabelHistory({ variantId, companyKey }: { variantId: number; companyKey: number }) {
  const { data = [] } = useQuery<RetailLabelEvent[]>({
    queryKey: ["retail-variant-labels", companyKey, variantId],
    queryFn: () => getJson(`/api/retail/variants/${variantId}/labels`),
    enabled: variantId > 0,
  });
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">Label prints</h3>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No labels printed yet.</p>
      ) : (
        <ul className="space-y-0.5 text-sm">
          {data.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-2">
              <span>{new Date(event.createdAt).toLocaleString()}</span>
              <span data-i18n-ui>{event.isReprint ? "Reprint" : "First print"}</span>
              <span>× {event.copies}</span>
              <span className="text-muted-foreground">{event.layout}</span>
              <span className="font-mono text-muted-foreground">{event.barcode}</span>
              <span className="text-muted-foreground">{event.createdBy ?? ""}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
