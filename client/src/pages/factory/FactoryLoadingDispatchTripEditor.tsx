// Extracted from ./FactoryLoadingDispatch.tsx to keep that module under the source-size cap.
import type { FormEvent } from "react";
import { Loader2, Package } from "lucide-react";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FACTORY_DISPATCH_TRIP_STATUS_LABELS, type FactoryDispatchTripStatus } from "@shared/factoryStatusPresentation";

interface OrderBale {
  id: number;
  baleId: number;
  weight: string | number;
}

export interface LoadingOrder {
  id: number;
  status: string;
  customerName?: string | null;
  containerNumber?: string | null;
  bales: OrderBale[];
}

type TripStatus = FactoryDispatchTripStatus;

export interface DispatchTrip {
  id: number;
  orderId: number;
  dispatchNumber: number;
  status: TripStatus;
  containerNumberSnapshot?: string | null;
  truckPlate: string | null;
  driverName: string | null;
  destination: string | null;
  notes: string | null;
  createdAt: string;
  createdByUsername?: string;
  updatedAt?: string;
  closedAt?: string | null;
  scannedBales?: number | string;
  scannedWeightKg?: number | string;
}

export interface DispatchList {
  orderId: number;
  containerNumber: string | null;
  dispatches: DispatchTrip[];
}

export interface TripForm {
  tripNumber: string;
  notes: string;
}

export type TripFilter = "all" | "open" | "closed";

export const blankForm: TripForm = { tripNumber: "", notes: "" };

export const activeOrderStatuses = new Set(["DRAFT", "LOADING", "PENDING_VERIFICATION"]);

export function tripPath(orderId: number, dispatchId?: number): string {
  return "/factory/sales/loading/dispatch/" + orderId + (dispatchId ? "/" + dispatchId : "");
}

export function numberValue(raw: number | string | undefined): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function printNumber(n: number, digits = 0): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export async function getJson<T>(url: string): Promise<T> {
  // After a rolling deployment some intermediaries can briefly return the
  // SPA HTML shell for an API GET. Never interpret it as dispatch evidence.
  // One cache-busted retry allows the client to recover without operator
  // action while preserving real JSON errors and authorization responses.
  for (let attempt = 0; attempt < 2; attempt++) {
    const requestUrl = attempt === 0 ? url : url + (url.includes("?") ? "&" : "?") + "_dispatch_retry=" + Date.now();
    const response = await fetch(requestUrl, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      // Retry only successful non-JSON responses. A 401, 403, 404, or 5xx
      // should not be masked by retrying an unrelated fallback page.
      if (response.ok && attempt === 0) continue;
      throw new Error(
        "Dispatch API returned " +
          (contentType || "an unknown content type") +
          " instead of JSON (HTTP " +
          response.status +
          "). " +
          "The server or proxy served an invalid API response; please retry."
      );
    }
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body?.message || "Unable to load dispatch information (HTTP " + response.status + ")");
    }
    return body as T;
  }
  throw new Error("Dispatch API did not return JSON after retry");
}

export function getError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred";
}

export function fromTrip(trip: DispatchTrip): TripForm {
  return {
    tripNumber: String(trip.dispatchNumber),
    notes: trip.notes ?? "",
  };
}

export function TripStatusBadge({ status }: { status: TripStatus }) {
  return <StatusBadge status={status} label={FACTORY_DISPATCH_TRIP_STATUS_LABELS[status]} showIcon={false} />;
}

export function StatCard({
  label,
  value,
  unit,
  icon: Icon,
}: {
  label: string;
  value: string;
  unit?: string;
  icon: typeof Package;
}) {
  return (
    <Card className="border-slate-200/90 bg-white/90 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
      <CardContent className="flex items-center justify-between gap-2 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p
            className="mt-1 font-mono text-xl font-bold tracking-tight sm:text-2xl"
            data-testid={"stat-" + label.toLowerCase().replace(/\s+/g, "-")}
          >
            {value} {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
          </p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-sky-300">
          <Icon className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}

export function TripEditor({
  open,
  onOpenChange,
  value,
  onChange,
  onSubmit,
  title,
  submitLabel,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: TripForm;
  onChange: (next: TripForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  title: string;
  submitLabel: string;
  busy: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Choose a unique trip number for this loading. Notes are optional.</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" data-testid="dispatch-trip-form">
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-trip-number">Trip number</Label>
            <Input
              id="dispatch-trip-number"
              type="number"
              min={1}
              max={2147483647}
              step={1}
              required
              value={value.tripNumber}
              placeholder="e.g. 1"
              onChange={(e) => onChange({ ...value, tripNumber: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-notes">Notes</Label>
            <Textarea
              id="dispatch-notes"
              maxLength={3000}
              rows={3}
              value={value.notes}
              placeholder="Optional instructions or loading notes"
              onChange={(e) => onChange({ ...value, notes: e.target.value })}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy} data-testid="button-save-dispatch">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
