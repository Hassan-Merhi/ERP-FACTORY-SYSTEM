// Extracted from ./EditEmployeeDialog.tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { MapPin, Plus, X } from "lucide-react";
import { SectionTitle } from "./EditEmployeeSectionTitle";
import type { EditEmployeeDialogProps } from "./EditEmployeeDialog";

export function EditEmployeeBaleRatesSection({
  setEditBaleRates,
  editBaleRates,
  allCompanyLocations,
  locations,
  otherCompanies,
  selectedCompany,
  setEditBalePctRates,
  editBalePctRates,
}: {
  setEditBaleRates: EditEmployeeDialogProps["setEditBaleRates"];
  editBaleRates: EditEmployeeDialogProps["editBaleRates"];
  allCompanyLocations: EditEmployeeDialogProps["allCompanyLocations"];
  locations: EditEmployeeDialogProps["locations"];
  otherCompanies: EditEmployeeDialogProps["otherCompanies"];
  selectedCompany: EditEmployeeDialogProps["selectedCompany"];
  setEditBalePctRates: EditEmployeeDialogProps["setEditBalePctRates"];
  editBalePctRates: EditEmployeeDialogProps["editBalePctRates"];
}) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-xs">
      <SectionTitle
        icon={MapPin}
        title="Location bonus rules"
        description="Set fixed bale rates and percentage rates independently for each location."
      />

      <div className="mt-5 grid gap-5 xl:grid-cols-2">
        <div className="rounded-lg border bg-muted/15 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Label className="text-sm font-semibold">Bale Bonus Rates</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">Fixed amount per bale.</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setEditBaleRates((previous) => [...previous, { locationId: "", rate: "", sourceCompanyId: "" }])
              }
              data-testid="button-add-bale-rate"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Location
            </Button>
          </div>

          <div className="mt-3 space-y-2.5">
            {editBaleRates.length === 0 && (
              <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                No fixed bale rates configured.
              </div>
            )}
            {editBaleRates.map((row, index) => {
              const rowCompanyId = row.sourceCompanyId || "";
              const locationsForRow = rowCompanyId
                ? allCompanyLocations.filter((location) => String(location.companyId) === rowCompanyId)
                : locations;

              return (
                <div
                  key={`${rowCompanyId}-${row.locationId}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_100px_36px] gap-2"
                >
                  {otherCompanies.length > 0 ? (
                    <Select
                      value={rowCompanyId || "__current__"}
                      onValueChange={(value) =>
                        setEditBaleRates((previous) =>
                          previous.map((rateRow, rateIndex) =>
                            rateIndex === index
                              ? {
                                  ...rateRow,
                                  sourceCompanyId: value === "__current__" ? "" : value,
                                  locationId: "",
                                }
                              : rateRow
                          )
                        )
                      }
                    >
                      <SelectTrigger className="h-9 min-w-0 text-xs" data-testid={`select-bale-rate-company-${index}`}>
                        <SelectValue placeholder={selectedCompany?.name || "Company"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__current__">{selectedCompany?.name || "This company"}</SelectItem>
                        {otherCompanies.map((company) => (
                          <SelectItem key={company.id} value={String(company.id)}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex h-9 min-w-0 items-center truncate rounded-md border bg-background px-3 text-xs text-muted-foreground">
                      {selectedCompany?.name || "Company"}
                    </div>
                  )}

                  <Select
                    value={row.locationId}
                    onValueChange={(value) =>
                      setEditBaleRates((previous) =>
                        previous.map((rateRow, rateIndex) =>
                          rateIndex === index ? { ...rateRow, locationId: value } : rateRow
                        )
                      )
                    }
                  >
                    <SelectTrigger className="h-9 min-w-0" data-testid={`select-bale-rate-location-${index}`}>
                      <SelectValue placeholder="Location" />
                    </SelectTrigger>
                    <SelectContent>
                      {locationsForRow.map((location) => (
                        <SelectItem key={location.id} value={String(location.id)}>
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="Rate"
                    className="h-9 text-right"
                    value={row.rate}
                    onChange={(event) =>
                      setEditBaleRates((previous) =>
                        previous.map((rateRow, rateIndex) =>
                          rateIndex === index ? { ...rateRow, rate: event.target.value } : rateRow
                        )
                      )
                    }
                    data-testid={`input-bale-rate-${index}`}
                  />

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setEditBaleRates((previous) => previous.filter((_, rateIndex) => rateIndex !== index))
                    }
                    aria-label="Remove bale rate"
                    data-testid={`button-remove-bale-rate-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border bg-muted/15 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <Label className="text-sm font-semibold">Bales % by Location</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">Percentage-based bale bonus.</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setEditBalePctRates((previous) => [...previous, { locationId: "", pct: "", sourceCompanyId: "" }])
              }
              data-testid="button-add-bale-pct-rate"
            >
              <Plus className="mr-1.5 h-3.5 w-3.5" /> Add Location
            </Button>
          </div>

          <div className="mt-3 space-y-2.5">
            {editBalePctRates.length === 0 && (
              <div className="rounded-md border border-dashed px-3 py-5 text-center text-xs text-muted-foreground">
                No percentage bale rates configured.
              </div>
            )}
            {editBalePctRates.map((row, index) => {
              const rowCompanyId = row.sourceCompanyId || "";
              const locationsForRow = rowCompanyId
                ? allCompanyLocations.filter((location) => String(location.companyId) === rowCompanyId)
                : locations;

              return (
                <div
                  key={`${rowCompanyId}-${row.locationId}-${index}`}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_100px_36px] gap-2"
                >
                  {otherCompanies.length > 0 ? (
                    <Select
                      value={rowCompanyId || "__current__"}
                      onValueChange={(value) =>
                        setEditBalePctRates((previous) =>
                          previous.map((rateRow, rateIndex) =>
                            rateIndex === index
                              ? {
                                  ...rateRow,
                                  sourceCompanyId: value === "__current__" ? "" : value,
                                  locationId: "",
                                }
                              : rateRow
                          )
                        )
                      }
                    >
                      <SelectTrigger
                        className="h-9 min-w-0 text-xs"
                        data-testid={`select-bale-pct-rate-company-${index}`}
                      >
                        <SelectValue placeholder={selectedCompany?.name || "Company"} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__current__">{selectedCompany?.name || "This company"}</SelectItem>
                        {otherCompanies.map((company) => (
                          <SelectItem key={company.id} value={String(company.id)}>
                            {company.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="flex h-9 min-w-0 items-center truncate rounded-md border bg-background px-3 text-xs text-muted-foreground">
                      {selectedCompany?.name || "Company"}
                    </div>
                  )}

                  <Select
                    value={row.locationId}
                    onValueChange={(value) =>
                      setEditBalePctRates((previous) =>
                        previous.map((rateRow, rateIndex) =>
                          rateIndex === index ? { ...rateRow, locationId: value } : rateRow
                        )
                      )
                    }
                  >
                    <SelectTrigger className="h-9 min-w-0" data-testid={`select-bale-pct-rate-location-${index}`}>
                      <SelectValue placeholder="Location" />
                    </SelectTrigger>
                    <SelectContent>
                      {locationsForRow.map((location) => (
                        <SelectItem key={location.id} value={String(location.id)}>
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="%"
                    className="h-9 text-right"
                    value={row.pct}
                    onChange={(event) =>
                      setEditBalePctRates((previous) =>
                        previous.map((rateRow, rateIndex) =>
                          rateIndex === index ? { ...rateRow, pct: event.target.value } : rateRow
                        )
                      )
                    }
                    data-testid={`input-bale-pct-rate-${index}`}
                  />

                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setEditBalePctRates((previous) => previous.filter((_, rateIndex) => rateIndex !== index))
                    }
                    aria-label="Remove percentage bale rate"
                    data-testid={`button-remove-bale-pct-rate-${index}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
