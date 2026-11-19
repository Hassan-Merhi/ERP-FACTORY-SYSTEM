// Extracted from ./ContainerDetailErpView.tsx
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import {
  FileText,
  Truck,
  Trash2,
  HandCoins,
  RotateCcw,
  Edit,
  Download,
  Printer,
  Upload,
  ChevronDown,
  RefreshCw,
  ExternalLink,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ContainerDetailErpViewModel, ContainerErpView } from "./ContainerDetailErpViewModel";

export function ContainerErpHeader({
  m,
  v,
  containerData,
}: {
  m: ContainerDetailErpViewModel;
  v: ContainerErpView;
  containerData: NonNullable<ContainerDetailErpViewModel["containerData"]>;
}) {
  return (
    <PageHeader
      title={<span data-testid="text-container-number">Container {v.container.containerNumber}</span>}
      backTarget={m.backUrl}
      meta={
        <>
          <Badge
            variant={
              v.container.status === "OTW" ? "default" : v.container.status === "OFFLOADED" ? "secondary" : "outline"
            }
            className="shrink-0"
            data-testid="badge-status"
          >
            {v.container.status}
          </Badge>
          <span>Imported on {m.formatDisplayDate(v.container.importDate)}</span>
        </>
      }
    >
      {/* View Offload button — only shown on offloaded containers */}
      {v.container.status === "OFFLOADED" && containerData?.offloadId && (
        <Button
          variant="outline"
          className="gap-2"
          onClick={() =>
            m.setLocation(
              `${m.backUrl.startsWith("/properties") ? "/properties" : ""}/offloads/${containerData.offloadId}`
            )
          }
          data-testid="button-view-offload"
        >
          <ExternalLink className="w-4 h-4" />
          View Offload
        </Button>
      )}
      {/* Actions dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2" data-testid="button-actions-dropdown">
            Actions
            <ChevronDown className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {!m.isPropertiesContainer && m.isDeveloper && m.canChangeExistingRecords && (
            <>
              <DropdownMenuItem
                onClick={() => m.syncVoucherMutation.mutate()}
                disabled={m.syncVoucherMutation.isPending}
                data-testid="button-sync-voucher"
              >
                <RefreshCw className="w-4 h-4 mr-2" />
                {m.syncVoucherMutation.isPending ? "Syncing..." : "Sync Supplier Balance"}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            onClick={() =>
              m.setLocation(
                `${m.backUrl.startsWith("/properties") ? "/properties" : ""}/containers/${m.containerId}/verification`
              )
            }
            data-testid="button-verify-container"
          >
            <FileText className="w-4 h-4 mr-2" />
            Verify
          </DropdownMenuItem>
          {!m.isPropertiesContainer && !m.containerSale && m.canCreate("POST", "/api/container-sales") && (
            <DropdownMenuItem onClick={() => m.setShowSellDialog(true)} data-testid="button-sell-container">
              <HandCoins className="w-4 h-4 mr-2" />
              Sell Container
            </DropdownMenuItem>
          )}
          {!m.isPropertiesContainer && m.canChangeExistingRecords && v.container.status !== "OFFLOADED" && (
            <DropdownMenuItem onClick={() => m.setShowOffloadDialog(true)} data-testid="button-offload-container">
              <Truck className="w-4 h-4 mr-2" />
              Offload Container
            </DropdownMenuItem>
          )}
          {!m.isPropertiesContainer && m.canChangeExistingRecords && v.container.status === "OFFLOADED" && (
            <>
              <DropdownMenuItem onClick={() => m.setShowOffloadDialog(true)} data-testid="button-edit-offload">
                <Edit className="w-4 h-4 mr-2" />
                Edit Offload
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() =>
                  m.setPendingDelete(() => () => m.reverseOffloadMutation.mutate(parseInt(m.containerId!)))
                }
                disabled={m.reverseOffloadMutation.isPending}
                data-testid="button-reverse-offload"
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Reverse Offload
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Export dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="gap-2" data-testid="button-export-dropdown">
            <Download className="w-4 h-4" />
            Export
            <ChevronDown className="w-4 h-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={m.handleExportContainer} data-testid="button-export-excel">
            <Download className="w-4 h-4 mr-2" />
            Full Export
          </DropdownMenuItem>
          <DropdownMenuItem onClick={m.handleExportContainerNoCost} data-testid="button-export-no-cost">
            <Download className="w-4 h-4 mr-2" />
            No Cost / Freight Export
          </DropdownMenuItem>
          <DropdownMenuItem onClick={m.handlePrint} data-testid="button-export-pdf">
            <Printer className="w-4 h-4 mr-2" />
            Export PDF
          </DropdownMenuItem>
          {!m.isPropertiesContainer && m.canChangeExistingRecords && <DropdownMenuSeparator />}
          {!m.isPropertiesContainer && m.canChangeExistingRecords && (
            <DropdownMenuItem
              onClick={() => {
                m.setPriceImportPreview(null);
                m.setPriceImportError(null);
                m.setShowPriceImportDialog(true);
              }}
              data-testid="button-import-pricing"
            >
              <Upload className="w-4 h-4 mr-2" />
              Import Pricing (Excel)
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {!m.isPropertiesContainer && m.canChangeExistingRecords && (
        <Button
          variant="destructive"
          onClick={m.handleDeleteContainer}
          disabled={m.deleteContainerMutation.isPending}
          className="gap-2"
          data-testid="button-delete-container"
        >
          <Trash2 className="w-4 h-4" />
          <span className="hidden sm:inline">Delete Container</span>
          <span className="sm:hidden">Delete</span>
        </Button>
      )}
    </PageHeader>
  );
}
