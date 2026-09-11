import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImagePlus } from "lucide-react";
import type { CustomerLogoRow, CustomerOption } from "./types";

export function BaleLogoPickerPopover({
  productId,
  overrideLogoId,
  allCustomers,
  onSelect,
  open,
  onOpenChange,
}: {
  productId: number;
  overrideLogoId: number | null;
  allCustomers: CustomerOption[];
  onSelect: (logoId: number | null) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pickerCustomerId, setPickerCustomerId] = useState("none");
  const { data: logos = [] } = useQuery<CustomerLogoRow[]>({
    queryKey: ["/api/factory/customers", pickerCustomerId, "logos"],
    queryFn: () =>
      fetch(`/api/factory/customers/${pickerCustomerId}/logos`, { credentials: "include" }).then((r) => r.json()),
    enabled: pickerCustomerId !== "none",
  });
  const activeCustomers = allCustomers.filter((c) => c.active);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-testid={`button-logo-override-${productId}`}
          title={overrideLogoId ? "Custom logo assigned — click to change" : "Assign customer logo for this bale"}
        >
          {overrideLogoId ? (
            <img
              src={`/api/factory/customer-logos/${overrideLogoId}/image`}
              alt="Logo"
              className="h-5 w-8 object-contain rounded"
            />
          ) : (
            <ImagePlus className="h-4 w-4 text-muted-foreground" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end">
        <p className="text-xs font-medium text-muted-foreground mb-2">Label logo (this bale only)</p>
        <div className="space-y-2">
          <Select value={pickerCustomerId} onValueChange={setPickerCustomerId}>
            <SelectTrigger className="text-sm">
              <SelectValue placeholder="Choose customer..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— Choose customer —</SelectItem>
              {activeCustomers.map((c) => (
                <SelectItem key={c.id} value={String(c.id)}>
                  {c.legalName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {pickerCustomerId !== "none" &&
            (logos.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">No logos uploaded for this customer.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {logos.map((logo) => (
                  <button
                    key={logo.id}
                    type="button"
                    onClick={() => {
                      onSelect(logo.id);
                      onOpenChange(false);
                    }}
                    className={`flex flex-col items-center gap-0.5 p-1.5 rounded-md border text-xs ${overrideLogoId === logo.id ? "border-primary bg-primary/10" : "border-border hover-elevate"}`}
                    data-testid={`bale-logo-option-${productId}-${logo.id}`}
                  >
                    <img
                      src={`/api/factory/customer-logos/${logo.id}/image`}
                      alt={logo.name}
                      className="h-6 w-10 object-contain"
                    />
                    <span className="truncate max-w-[56px]">{logo.name}</span>
                  </button>
                ))}
              </div>
            ))}
          {overrideLogoId && (
            <button
              className="text-xs text-muted-foreground underline hover:text-foreground mt-1"
              onClick={() => {
                onSelect(null);
                onOpenChange(false);
              }}
              data-testid={`bale-logo-clear-${productId}`}
            >
              Clear logo
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
