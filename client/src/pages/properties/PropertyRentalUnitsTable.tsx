// Extracted from ./PropertyRentalPage.tsx
import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronRight, Trash2, MapPin, Building2, UserRound, CalendarDays, Pencil } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { format } from "date-fns";
import type { Unit } from "./property-rental/types";
import { fmtMoneyCurrency } from "./property-rental/utils";
import { NoteCell } from "./property-rental/components/NoteCell";
import type { PropertyRentalPageModel } from "./PropertyRentalPageModel";

export function PropertyRentalUnitsTable({ m }: { m: PropertyRentalPageModel }) {
  return (
    <Card
      className={
        m.isFactoryShopTable
          ? "factory-rentals-table-shell"
          : m.isPropertiesRental
            ? "properties-rentals-table-shell"
            : undefined
      }
    >
      <CardContent className={m.isFactoryShopTable ? "p-2 sm:p-3" : m.isPropertiesRental ? "p-2 sm:p-4" : "p-0"}>
        <div data-horizontal-scroll="true" className="overflow-x-auto">
          {m.isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading units…</div>
          ) : m.grouped.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">
              {m.unitType === "WAREHOUSE"
                ? "No warehouses yet. Add your first unit above."
                : "No shops yet. Add your first unit above."}
            </div>
          ) : (
            <table
              className={
                m.isFactoryShopTable
                  ? "factory-rentals-table w-full text-sm"
                  : m.isPropertiesRental
                    ? "properties-rentals-data-table w-full min-w-[1170px] text-sm"
                    : "w-full text-sm"
              }
            >
              <thead
                className={
                  m.isPropertiesRental
                    ? "properties-rentals-table-head sticky top-0 z-30"
                    : "bg-muted border-b sticky top-0 z-30"
                }
              >
                <tr>
                  <th className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={m.contractedUnits.length > 0 && m.selectedContractIds.size === m.contractedUnits.length}
                      onCheckedChange={m.toggleSelectAll}
                      data-testid={`checkbox-${m.testIdPrefix}-select-all`}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="text-left px-3 py-2 font-semibold">Unit</th>
                  <th className="text-left px-3 py-2 font-semibold">Dimensions</th>
                  <th className="text-left px-3 py-2 font-semibold">Tenant</th>
                  <th className="text-left px-3 py-2 font-semibold">Note</th>
                  <th className="text-right px-3 py-2 font-semibold">Monthly Rent</th>
                  <th className="text-right px-3 py-2 font-semibold">Guarantee</th>
                  <th className="text-right px-3 py-2 font-semibold">
                    {m.isPropertiesRental ? "Tenant Balance" : "Outstanding"}
                  </th>
                  <th className="text-right px-3 py-2 font-semibold text-muted-foreground">Scheduled</th>
                  <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Next Billing</th>
                  <th className="text-left px-3 py-2 font-semibold">Start</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {m.grouped.map(([group, groupUnits], gIdx) => {
                  const GROUP_PALETTE = [
                    { headerBg: "#1d4ed8", headerText: "#fff", r: 29, g: 78, b: 216 },
                    { headerBg: "#047857", headerText: "#fff", r: 4, g: 120, b: 87 },
                    { headerBg: "#7c3aed", headerText: "#fff", r: 124, g: 58, b: 237 },
                    { headerBg: "#b45309", headerText: "#fff", r: 180, g: 83, b: 9 },
                    { headerBg: "#be123c", headerText: "#fff", r: 190, g: 18, b: 60 },
                    { headerBg: "#0e7490", headerText: "#fff", r: 14, g: 116, b: 144 },
                    { headerBg: "#c2410c", headerText: "#fff", r: 194, g: 65, b: 12 },
                    { headerBg: "#4d7c0f", headerText: "#fff", r: 77, g: 124, b: 15 },
                  ];
                  const p = GROUP_PALETTE[gIdx % GROUP_PALETTE.length];
                  const rowBgEven = `rgba(${p.r},${p.g},${p.b},0.06)`;
                  const rowBgOdd = `rgba(${p.r},${p.g},${p.b},0.12)`;
                  const unitNumBg = `rgba(${p.r},${p.g},${p.b},0.18)`;
                  const unitNumColor = p.headerBg;
                  return (
                    <Fragment key={group}>
                      <tr
                        key={`grp-${group}`}
                        className={
                          m.isFactoryShopTable
                            ? "factory-rentals-location-row"
                            : m.isPropertiesRental
                              ? "properties-rentals-group-row"
                              : "border-t"
                        }
                      >
                        <td
                          colSpan={12}
                          className={
                            m.isFactoryShopTable
                              ? "factory-rentals-location-cell"
                              : m.isPropertiesRental
                                ? "properties-rentals-group-cell px-4 py-3 text-xs font-bold uppercase tracking-wider"
                                : "px-3 py-1.5 text-xs font-bold uppercase tracking-widest text-center"
                          }
                          style={
                            m.isFactoryShopTable || m.isPropertiesRental
                              ? undefined
                              : { backgroundColor: p.headerBg, color: p.headerText }
                          }
                        >
                          {m.isFactoryShopTable ? (
                            <div
                              className="factory-rentals-location-bar"
                              style={{ background: `linear-gradient(110deg, ${p.headerBg}, ${p.headerBg}df)` }}
                            >
                              <MapPin className="h-4 w-4 shrink-0" aria-hidden="true" />
                              <span>{group}</span>
                              <span className="factory-rentals-location-count">
                                {groupUnits.length} {groupUnits.length === 1 ? "unit" : "units"}
                              </span>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-2">
                              {m.isPropertiesRental && <Building2 className="h-4 w-4" aria-hidden="true" />}
                              <span>{group}</span>
                              {m.isPropertiesRental && m.editableUnitInGroup(groupUnits) && (
                                <button
                                  type="button"
                                  className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-white/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    m.openRenameGroup(group, groupUnits);
                                  }}
                                  title={`Rename ${group}`}
                                  aria-label={`Rename location group ${group}`}
                                  data-testid={`button-${m.testIdPrefix}-rename-group-${gIdx}`}
                                >
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                      </tr>
                      {groupUnits.map((u, uIdx) => (
                        <tr
                          key={u.id}
                          className={
                            m.isFactoryShopTable
                              ? `factory-rentals-unit-row cursor-pointer${u.contract && m.selectedContractIds.has(u.contract.id) ? " factory-rentals-unit-row-selected" : ""}`
                              : m.isPropertiesRental
                                ? "properties-rentals-unit-row cursor-pointer transition-colors"
                                : "border-t cursor-pointer transition-colors"
                          }
                          style={
                            m.isFactoryShopTable
                              ? ({ "--factory-rentals-rgb": `${p.r}, ${p.g}, ${p.b}` } as React.CSSProperties)
                              : m.isPropertiesRental
                                ? undefined
                                : { backgroundColor: uIdx % 2 === 0 ? rowBgEven : rowBgOdd }
                          }
                          onMouseEnter={(e) => {
                            if (!m.isFactoryShopTable && !m.isPropertiesRental)
                              e.currentTarget.style.filter = "brightness(0.93)";
                          }}
                          onMouseLeave={(e) => {
                            if (!m.isFactoryShopTable && !m.isPropertiesRental) e.currentTarget.style.filter = "";
                          }}
                          onClick={() => m.setOpenUnitId(u.id)}
                          data-testid={`row-unit-${u.id}`}
                        >
                          <td className="px-3 py-2 w-8" onClick={(e) => e.stopPropagation()}>
                            {u.contract && !u.isShared && !u.isInternalLeaseProjection && (
                              <Checkbox
                                checked={m.selectedContractIds.has(u.contract.id)}
                                onCheckedChange={() =>
                                  m.toggleSelect(u.contract!.id, {
                                    stopPropagation: () => {},
                                  } as React.MouseEvent<Element, MouseEvent>)
                                }
                                onClick={(e) => e.stopPropagation()}
                                data-testid={`checkbox-unit-${u.id}`}
                                aria-label={`Select ${u.unitNumber}`}
                              />
                            )}
                          </td>
                          <td
                            className={m.isFactoryShopTable ? "px-3 py-2" : "px-3 py-2 font-mono text-xs font-bold"}
                            style={
                              m.isFactoryShopTable || m.isPropertiesRental
                                ? undefined
                                : { backgroundColor: unitNumBg, color: unitNumColor }
                            }
                          >
                            {m.isFactoryShopTable || m.isPropertiesRental ? (
                              <span
                                className={
                                  m.isPropertiesRental ? "properties-rentals-unit-pill" : "factory-rentals-unit-pill"
                                }
                                style={
                                  m.isFactoryShopTable
                                    ? { color: p.headerBg, backgroundColor: `rgba(${p.r},${p.g},${p.b},0.15)` }
                                    : undefined
                                }
                              >
                                <Building2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                {u.unitNumber}
                              </span>
                            ) : (
                              u.unitNumber
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {u.dimensions ? (
                              <span className="font-medium text-foreground">{u.dimensions}</span>
                            ) : u.size ? (
                              <span>{u.size}</span>
                            ) : (
                              <span>—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {u.contract ? (
                              <span className="font-medium flex items-center gap-1.5 flex-wrap">
                                {m.isFactoryShopTable && (
                                  <UserRound
                                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                                    aria-hidden="true"
                                  />
                                )}
                                {u.contract.tenantName}
                                {u.contract.isInternal && (
                                  <Badge className="text-xs bg-violet-600 text-white">Internal</Badge>
                                )}
                                {u.isInternalLeaseProjection && (
                                  <Badge className="text-xs bg-violet-600 text-white">
                                    {u.sourceModule === "ERP" ? "ERP reference" : "Factory reference"}
                                  </Badge>
                                )}
                                {u.isShared && !u.isInternalLeaseProjection && (
                                  <Badge
                                    className="text-xs bg-sky-600 text-white"
                                    title={u.ownerCompanyName ? `From: ${u.ownerCompanyName}` : undefined}
                                  >
                                    Shared
                                  </Badge>
                                )}
                              </span>
                            ) : (
                              <Badge variant="secondary" className="text-xs">
                                Vacant
                              </Badge>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            {u.contract ? (
                              u.isInternalLeaseProjection ? (
                                <span className="text-xs text-muted-foreground">{u.contract.notes || "—"}</span>
                              ) : (
                                <NoteCell contractId={u.contract.id} note={u.contract.notes} testId={`unit-${u.id}`} />
                              )
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            <span className={m.isPropertiesRental ? "properties-rentals-money-pill" : undefined}>
                              {u.contract ? fmtMoneyCurrency(u.contract.rentalAmount, u.contract.currency) : "—"}
                            </span>
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums font-semibold ${
                              u.contract && Number(u.contract.guaranteeAmount) > 0
                                ? u.contract.guaranteePostedToStatement
                                  ? m.isPropertiesRental
                                    ? "text-red-600 dark:text-red-400"
                                    : "text-green-600 dark:text-green-400"
                                  : m.isPropertiesRental
                                    ? "text-amber-600 dark:text-amber-400"
                                    : "text-red-600 dark:text-red-400"
                                : "text-muted-foreground"
                            }`}
                          >
                            <span
                              className={
                                m.isFactoryShopTable
                                  ? "factory-rentals-money-pill"
                                  : m.isPropertiesRental
                                    ? "properties-rentals-money-pill"
                                    : undefined
                              }
                            >
                              {u.contract
                                ? fmtMoneyCurrency(
                                    (
                                      u as unknown as Unit & {
                                        guaranteeRemaining: string | number | null | undefined;
                                      }
                                    ).guaranteeRemaining ?? u.contract.guaranteeAmount,
                                    u.contract.currency
                                  )
                                : "—"}
                            </span>
                          </td>
                          <td
                            className={`px-3 py-2 text-right tabular-nums font-semibold ${(u.outstanding ?? 0) > 0 ? (m.isPropertiesRental ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400") : (u.prepaidCredit ?? 0) > 0 ? (m.isPropertiesRental ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400") : "text-muted-foreground"}`}
                          >
                            <span
                              className={
                                m.isFactoryShopTable
                                  ? "factory-rentals-money-pill"
                                  : m.isPropertiesRental
                                    ? "properties-rentals-money-pill"
                                    : undefined
                              }
                            >
                              {u.outstanding !== null
                                ? fmtMoneyCurrency(
                                    (u.outstanding ?? 0) > 0
                                      ? u.outstanding!
                                      : (u as { prepaidCredit: 0 }).prepaidCredit > 0
                                        ? u.prepaidCredit
                                        : 0,
                                    u.contract?.currency
                                  )
                                : "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-muted-foreground text-xs">
                            {(u as { scheduledAmount: 0 }).scheduledAmount > 0
                              ? fmtMoneyCurrency(u.scheduledAmount, u.contract?.currency)
                              : "—"}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            <span className={m.isPropertiesRental ? "properties-rentals-date" : "factory-rentals-date"}>
                              {(m.isFactoryShopTable || m.isPropertiesRental) && (
                                <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              )}
                              {u.nextBillingDate ? format(new Date(u.nextBillingDate + "T00:00:00Z"), "dd MMM") : "—"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">
                            <span className={m.isPropertiesRental ? "properties-rentals-date" : "factory-rentals-date"}>
                              {(m.isFactoryShopTable || m.isPropertiesRental) && (
                                <CalendarDays className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                              )}
                              {u.contract ? format(new Date(u.contract.startDate), "dd MMM yyyy") : "—"}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-end gap-1">
                              {!u.isShared && !u.isInternalLeaseProjection && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="text-muted-foreground hover:text-destructive"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    m.setConfirmDeleteUnitId(u.id);
                                  }}
                                  data-testid={`button-delete-unit-${u.id}`}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                              <ChevronRight className="h-4 w-4 text-muted-foreground" />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
