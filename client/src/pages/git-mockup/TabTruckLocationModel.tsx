// Extracted from ./TabTruckLocation.tsx: state, queries and handlers for TabTruckLocation.
import { cn } from "@/lib/utils";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { authenticatedUserQueryOptions } from "@/contracts/sessionQueryContracts";
import { Button } from "@/components/ui/button";
import { Building2, Layers3 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { gitContainersUrl } from "./helpers";
import type { GitContainersResponse, EnrichedContainerApi, CompanyViewMode } from "./types";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { isExistingRecordReadOnlyRole } from "@shared/createOnlyRolePolicy";

export function useTabTruckLocationModel() {
  const { data: viewer } = useQuery(authenticatedUserQueryOptions());
  const role = viewer?.currentRole ?? viewer?.role;
  const isTester = role === "ERP Tester";
  const isViewer = isExistingRecordReadOnlyRole(role);
  const restrictedViewer = isTester || isViewer;
  const [companyMode, setCompanyMode] = useState<CompanyViewMode>("session");
  const [waSending, setWaSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [truckView, setTruckView] = useState<"with" | "without" | "all">("with");
  const [statusFilter, setStatusFilter] = useState("all");
  const [shopFilter, setShopFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  const printRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const isPhone = useErpPhoneLayout();

  const queryUrl = gitContainersUrl({ allCompanies: companyMode === "all", includeOffloaded: true });

  const { data, isLoading, isError, error } = useQuery<GitContainersResponse>({
    queryKey: [queryUrl],
    staleTime: 60_000,
    retry: 1,
  });

  const allContainers: EnrichedContainerApi[] = data?.containers ?? [];
  const withTruck = allContainers.filter((r) => !!(r.numberPlate ?? "").trim());
  const noTruck = allContainers.filter((r) => !(r.numberPlate ?? "").trim());
  const shops = [...new Set(withTruck.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort();
  const shopOptions = [...new Set(allContainers.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
  const statusOptions = [...new Set(allContainers.map((r) => r.status))].filter(Boolean).sort();
  const search = searchQuery.trim().toLocaleLowerCase();
  const visibleRows = allContainers.filter((row) => {
    const hasTruck = Boolean((row.numberPlate ?? "").trim());
    if (truckView === "with" && !hasTruck) return false;
    if (truckView === "without" && hasTruck) return false;
    if (statusFilter !== "all" && row.status !== statusFilter) return false;
    const shop = row.shopName ?? row.companyName ?? "Unknown";
    if (shopFilter !== "all" && shop !== shopFilter) return false;
    if (!search) return true;
    return [
      row.containerNumber,
      row.supplierCode,
      row.numberPlate,
      row.trackingLocation,
      row.agent,
      row.transporter,
      row.status,
      shop,
    ].some((value) =>
      String(value ?? "")
        .toLocaleLowerCase()
        .includes(search)
    );
  });
  const visibleShops = [...new Set(visibleRows.map((r) => r.shopName ?? r.companyName ?? "Unknown"))].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })
  );
  const activeFilterCount = Number(statusFilter !== "all") + Number(shopFilter !== "all");

  function resetFilters() {
    setSearchQuery("");
    setTruckView("with");
    setStatusFilter("all");
    setShopFilter("all");
  }

  async function sendToWhatsApp() {
    if (!printRef.current) return;
    setWaSending(true);
    try {
      const html2canvas = (await import("html2canvas")).default;
      const el = printRef.current;
      const sourceCanvas = await html2canvas(el, {
        scale: 1,
        useCORS: true,
        allowTaint: true,
        backgroundColor: "#f8fafc",
        logging: false,
        width: el.scrollWidth,
        height: el.scrollHeight,
        windowWidth: el.scrollWidth,
        windowHeight: el.scrollHeight,
      });

      const today = new Date().toISOString().substring(0, 10);
      const fileName = `TruckLocation_${today}.jpg`;
      // The API has a 2 MB JSON body limit. Base64 expands binary data by ~33%,
      // so enforce the actual serialized request size instead of estimating only
      // the decoded JPEG size. Keep headroom for middleware/proxy overhead.
      const MAX_JSON_BYTES = 1.55 * 1024 * 1024;
      const dimensionScales = [1, 0.86, 0.72, 0.6, 0.5];
      const qualities = [0.78, 0.64, 0.52, 0.42, 0.34];
      let imageBase64 = "";

      outer: for (const scale of dimensionScales) {
        let candidateCanvas = sourceCanvas;
        if (scale !== 1) {
          candidateCanvas = document.createElement("canvas");
          candidateCanvas.width = Math.max(1, Math.round(sourceCanvas.width * scale));
          candidateCanvas.height = Math.max(1, Math.round(sourceCanvas.height * scale));
          const context = candidateCanvas.getContext("2d");
          if (!context) continue;
          context.drawImage(sourceCanvas, 0, 0, candidateCanvas.width, candidateCanvas.height);
        }

        for (const quality of qualities) {
          const candidate = candidateCanvas.toDataURL("image/jpeg", quality);
          const payloadBytes = new TextEncoder().encode(
            JSON.stringify({ imageBase64: candidate, fileName })
          ).byteLength;
          if (payloadBytes <= MAX_JSON_BYTES) {
            imageBase64 = candidate;
            break outer;
          }
        }
      }

      if (!imageBase64) {
        toast({
          title: "Failed to send",
          description: "The tracking report is too large to fit in one WhatsApp image even after compression.",
          variant: "destructive",
        });
        return;
      }

      try {
        await apiRequest("POST", "/api/git/send-containers-whatsapp", {
          imageBase64,
          fileName,
        });
      } catch (apiErr) {
        const msg =
          getErrorDetails(apiErr).status === 413 ||
          String(getErrorDetails(apiErr).optionalMessage).toLowerCase().includes("too large")
            ? "Tracking report is still too large to send to WhatsApp."
            : (getErrorDetails(apiErr).optionalMessage ?? "Failed to send");
        toast({ title: "Failed to send", description: msg, variant: "destructive" });
        return;
      }

      toast({ title: "Sent", description: "Truck / Location report sent to WhatsApp group." });
    } catch (err) {
      toast({ title: "Failed to send", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setWaSending(false);
    }
  }

  const modeSelector = (
    <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:grid max-sm:grid-cols-2 max-sm:[&>button]:h-auto max-sm:[&>button]:whitespace-normal max-sm:[&>button]:py-2">
      <span className="mr-1 hidden text-xs font-medium text-muted-foreground sm:inline">Viewing</span>
      <Button
        size="sm"
        variant={companyMode === "session" ? "default" : "outline"}
        className={cn(
          "rounded-lg shadow-none",
          companyMode === "session" &&
            "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500"
        )}
        onClick={() => setCompanyMode("session")}
        data-testid="btn-truck-mode-session"
      >
        <Building2 className="mr-1.5 h-3.5 w-3.5" />
        My Company
      </Button>
      {!restrictedViewer && (
        <Button
          size="sm"
          variant={companyMode === "all" ? "default" : "outline"}
          className={cn(
            "rounded-lg shadow-none",
            companyMode === "all" &&
              "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-600 dark:hover:bg-violet-500"
          )}
          onClick={() => setCompanyMode("all")}
          data-testid="btn-truck-mode-all"
        >
          <Layers3 className="mr-1.5 h-3.5 w-3.5" />
          All Accessible Companies
        </Button>
      )}
    </div>
  );

  return {
    restrictedViewer,
    waSending,
    searchQuery,
    setSearchQuery,
    truckView,
    setTruckView,
    statusFilter,
    setStatusFilter,
    shopFilter,
    setShopFilter,
    showFilters,
    setShowFilters,
    printRef,
    isPhone,
    isLoading,
    isError,
    error,
    allContainers,
    withTruck,
    noTruck,
    shops,
    shopOptions,
    statusOptions,
    visibleRows,
    visibleShops,
    activeFilterCount,
    resetFilters,
    sendToWhatsApp,
    modeSelector,
  };
}

export type TabTruckLocationModel = ReturnType<typeof useTabTruckLocationModel>;
