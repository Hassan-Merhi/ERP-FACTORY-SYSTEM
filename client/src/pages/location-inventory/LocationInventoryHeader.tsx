import { releaseDebtEnglish } from "@/i18n/finalCloseoutTranslations";
import { AlertCircle, ChevronDown, Loader2, MessageCircle, Warehouse, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LocationWhatsappScheduleDialog } from "./LocationWhatsappScheduleDialog";
import { LocationWhatsappDeliveryHistoryDialog } from "./LocationWhatsappDeliveryHistoryDialog";
import { WarehouseScene } from "./WarehouseScene";
import { useLocationInventoryHeaderState, type LocationInventoryHeaderProps } from "./useLocationInventoryHeaderState";

export function LocationInventoryHeader({
  posUser,
  showNegativeStock,
  setShowNegativeStock,
  landing = false,
  locationsCount = null,
  negativeCount = null,
  linkedGroupsCount = null,
  activeReportsCount = null,
}: LocationInventoryHeaderProps) {
  const {
    selectedLocation,
    recordChanges,
    sendMode,
    companyId,
    canManageWhatsapp,
    canSendWithCost,
    whatsappReady,
    handleSendStock,
    whatsappButtonTitle,
    overviewStats,
  } = useLocationInventoryHeaderState({
    posUser,
    locationsCount,
    negativeCount,
    linkedGroupsCount,
    activeReportsCount,
  });

  return (
    <div className="shrink-0 p-2 sm:px-6 sm:pt-5">
      <div
        className={
          landing
            ? "relative isolate overflow-hidden rounded-[24px] border border-violet-200/80 bg-gradient-to-r from-violet-50 via-white to-indigo-100/90 shadow-[0_16px_40px_-32px_rgba(107,45,180,.5)] dark:border-violet-300/20 dark:from-[#191333] dark:via-[#17152f] dark:to-[#101a34]"
            : undefined
        }
      >
        {landing && (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -right-4 -top-8 h-[240px] w-[65%] opacity-[.16] dark:opacity-[.68] sm:w-[54%]"
            >
              <WarehouseScene />
            </div>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 bg-gradient-to-r from-white/75 via-white/40 to-transparent dark:from-[#15142d]/90 dark:via-[#15142d]/45 dark:to-transparent"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute -left-16 -top-16 h-52 w-60 rounded-full bg-purple-400/15 blur-3xl dark:bg-fuchsia-600/20"
            />
          </>
        )}
        <div
          className={
            landing
              ? "relative z-10 px-4 pt-4 sm:px-6 sm:pt-5 [&_[data-testid=page-header]]:!border-b-0 [&_[data-testid=page-header]]:!mb-0"
              : ""
          }
        >
          <PageHeader
            title="Location Inventory"
            icon={
              landing ? (
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-md shadow-violet-500/20">
                  <Warehouse className="h-5 w-5" />
                </span>
              ) : (
                <MapPin className="h-5 w-5" aria-hidden="true" />
              )
            }
            meta={
              <span className="min-w-0 truncate">
                {landing
                  ? "Manage inventory across all locations"
                  : selectedLocation
                    ? `Manage inventory for ${selectedLocation.name}`
                    : "Manage inventory across all locations"}
              </span>
            }
          >
            {!posUser && (
              <>
                {canManageWhatsapp && !landing && selectedLocation && (
                  <>
                    {recordChanges.allowed && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-9 gap-2 rounded-xl border-violet-300/60 bg-violet-600 px-3 text-white shadow-sm shadow-violet-500/20 hover:bg-violet-700 hover:text-white dark:border-violet-500/40 dark:bg-violet-600 dark:hover:bg-violet-500"
                            disabled={!whatsappReady || sendMode !== null}
                            title={whatsappButtonTitle}
                            data-testid="button-send-location-stock-whatsapp"
                          >
                            {sendMode ? (
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <MessageCircle className="h-4 w-4" />
                            )}
                            {sendMode ? "Sending…" : "Send Stock"}
                            {!sendMode && <ChevronDown className="h-3.5 w-3.5" />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-64">
                          <DropdownMenuItem
                            onClick={() => handleSendStock(false)}
                            disabled={sendMode !== null}
                            data-testid="menu-send-stock-whatsapp-no-cost"
                          >
                            <MessageCircle className="h-4 w-4 mr-2" />
                            <div>
                              <div className="font-medium">{releaseDebtEnglish("Send WITHOUT COST")}</div>
                              <div className="text-xs text-muted-foreground">
                                {releaseDebtEnglish("Quantity-only Godown Summary PDF")}
                              </div>
                            </div>
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => handleSendStock(true)}
                            disabled={sendMode !== null || !canSendWithCost}
                            data-testid="menu-send-stock-whatsapp-with-cost"
                          >
                            <MessageCircle className="h-4 w-4 mr-2" />
                            <div>
                              <div className="font-medium">{releaseDebtEnglish("Send WITH COST")}</div>
                              <div className="text-xs text-muted-foreground">
                                {canSendWithCost
                                  ? "Includes average rate and total value"
                                  : "Requires cost-price and total-value permission"}
                              </div>
                            </div>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}

                    <LocationWhatsappScheduleDialog
                      location={selectedLocation}
                      companyId={companyId}
                      canSendWithCost={canSendWithCost}
                    />

                    <LocationWhatsappDeliveryHistoryDialog
                      location={selectedLocation}
                      companyId={companyId}
                      canSendWithCost={canSendWithCost}
                    />
                  </>
                )}

                {!landing && (
                  <Button
                    variant={showNegativeStock ? "destructive" : "outline"}
                    size="sm"
                    className="h-9 gap-2 rounded-xl border-violet-200/80 bg-background/80 px-3 shadow-sm dark:border-violet-500/25 dark:bg-slate-950/35"
                    onClick={() => setShowNegativeStock(!showNegativeStock)}
                    data-testid="button-negative-stock"
                  >
                    <AlertCircle className="h-4 w-4" />
                    <span>{releaseDebtEnglish("Negative Stock")}</span>
                  </Button>
                )}
              </>
            )}
          </PageHeader>
        </div>
        {landing && (
          <div className="relative z-10 grid grid-cols-2 gap-2.5 px-4 pb-4 pt-1 sm:gap-3 sm:px-6 sm:pb-6 lg:grid-cols-4">
            {overviewStats
              .filter((stat) => !posUser || stat.label !== "Negative stock")
              .map((stat) => {
                const Icon = stat.icon;
                return (
                  <div
                    key={stat.label}
                    className={`flex min-w-0 items-center gap-3 rounded-[18px] border px-3 py-3 shadow-sm backdrop-blur-sm transition-transform hover:-translate-y-0.5 sm:px-4 ${stat.tone}`}
                  >
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] sm:h-11 sm:w-11 ${stat.iconTone}`}
                    >
                      <Icon className="h-5 w-5" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-xl font-extrabold leading-none tabular-nums sm:text-2xl">
                        {stat.value ?? "—"}
                      </div>
                      <div className="mt-1 truncate text-[11px] font-medium sm:text-xs">{stat.label}</div>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
