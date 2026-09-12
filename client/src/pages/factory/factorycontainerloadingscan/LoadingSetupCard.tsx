/**
 * Setup card of the container loading scan page: customer, loading location,
 * proforma, note and the Start Loading action.
 *
 * Split out of FactoryContainerLoadingScan.tsx unchanged — customer, location
 * and proforma lock once an order exists, and the note gains an explicit save
 * button only after the order is created.
 */
import { MapPin, Play, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

export function LoadingSetupCard({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { orderId, customerId, activeProformas } = model;
  return (
    <div className="rounded-xl border overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 border-b bg-muted/20">
        <span className="text-sm font-semibold">Setup</span>
      </div>
      <div className="p-4 space-y-4">
        <div>
          <label className="text-sm font-medium mb-1 block">Customer</label>
          <Select value={model.selectedCustomerId} onValueChange={model.setSelectedCustomerId} disabled={!!orderId}>
            <SelectTrigger data-testid="select-customer">
              <SelectValue placeholder="Select customer..." />
            </SelectTrigger>
            <SelectContent>
              {model.customers.map((c) => (
                <SelectItem key={c.id} value={c.id.toString()} data-testid={`select-customer-option-${c.id}`}>
                  {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label className="text-sm font-medium mb-1 block">
            <MapPin className="inline h-3 w-3 mr-1" />
            Loading Location
          </label>
          <Select value={model.selectedLocationId} onValueChange={model.setSelectedLocationId} disabled={!!orderId}>
            <SelectTrigger data-testid="select-location">
              <SelectValue placeholder="Select location..." />
            </SelectTrigger>
            <SelectContent>
              {model.locations.map((loc) => (
                <SelectItem key={loc.id} value={loc.id.toString()} data-testid={`select-location-option-${loc.id}`}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {customerId && !orderId && activeProformas.length > 0 && (
          <div className="space-y-1">
            <label className="text-sm font-medium">Proforma</label>
            <Select value={model.selectedProformaId} onValueChange={model.setSelectedProformaId} disabled={!!orderId}>
              <SelectTrigger data-testid="select-proforma">
                <SelectValue placeholder="Select a proforma..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none" data-testid="select-proforma-none">
                  No proforma
                </SelectItem>
                {activeProformas.map((p) => (
                  <SelectItem key={p.id} value={String(p.id)} data-testid={`select-proforma-option-${p.id}`}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {customerId && !orderId && activeProformas.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="text-no-proforma">
            No active proforma found. Loading will proceed without price references.
          </p>
        )}

        {/* Note field — editable before and after loading starts */}
        <div>
          <label className="text-sm font-medium mb-1 block">Note</label>
          {orderId ? (
            <div className="flex gap-2 items-start">
              <Textarea
                value={model.loadingNote}
                onChange={(e) => model.setLoadingNote(e.target.value)}
                placeholder="Add a note for this loading..."
                className="resize-none text-sm"
                rows={2}
                data-testid="input-loading-note"
              />
              <Button
                size="icon"
                variant="outline"
                onClick={() => model.saveNoteMutation.mutate(model.loadingNote)}
                disabled={model.saveNoteMutation.isPending}
                data-testid="button-save-note"
                title="Save note"
              >
                <Save className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Textarea
              value={model.loadingNote}
              onChange={(e) => model.setLoadingNote(e.target.value)}
              placeholder="Optional note (e.g. Rush order, Handle with care)"
              className="resize-none text-sm"
              rows={2}
              data-testid="input-loading-note"
            />
          )}
        </div>

        {!orderId && (
          <Button
            className="w-full"
            onClick={model.handleStartLoading}
            disabled={
              !customerId ||
              !model.selectedLocationId ||
              model.createOrderMutation.isPending ||
              model.isProformaCapacityLoading
            }
            data-testid="button-start-loading"
          >
            <Play className="mr-2 h-4 w-4" />
            {model.createOrderMutation.isPending ? "Creating..." : "Start Loading"}
          </Button>
        )}
      </div>
    </div>
  );
}
