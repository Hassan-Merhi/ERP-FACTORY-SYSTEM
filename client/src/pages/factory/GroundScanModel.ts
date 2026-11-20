// Extracted from ./GroundScan.tsx: state, queries and handlers for GroundScan.
import { getErrorDetails } from "@shared/errorUtils";
import { apiRequest } from "@/lib/queryClient";
import { STORAGE_KEY } from "./groundscan/utils";
import { useGroundScanState } from "./useGroundScanState";
import { exportGroundScanWorkbook } from "./groundScanExport";

export function useGroundScanModel() {
  const {
    clearMutation,
    exporting,
    hasMigrationData,
    invalidate,
    isLoading,
    localBales,
    removeMutation,
    scanError,
    scanInput,
    scanRef,
    scannedBales,
    scanning,
    selectedLocationId,
    serverItems,
    setExporting,
    setLocalBales,
    setScanError,
    setScanInput,
    setScanning,
    setSelectedLocationId,
    setUploading,
    stockLocations,
    toast,
    totalWeight,
    uploading,
  } = useGroundScanState();

  async function handleScan(code = scanInput) {
    const value = code.trim().toUpperCase();
    if (!value) return;

    const duplicate = serverItems.find((b) => b.reference_number === value);
    if (duplicate) {
      setScanError(`Already scanned: ${value}`);
      toast({ title: "Duplicate scan", description: `${value} is already in the list.`, variant: "destructive" });
      setScanInput("");
      return;
    }

    setScanError("");
    setScanning(true);

    try {
      const res = await fetch(`/api/lookup/reference/${encodeURIComponent(value)}`, { credentials: "include" });

      if (!res.ok) {
        if (res.status === 404) {
          setScanError(`Not found: ${value}`);
          toast({
            title: "Bale not found",
            description: `No bale with ref code "${value}" found.`,
            variant: "destructive",
          });
        } else {
          setScanError("Lookup failed — try again");
        }
        setScanInput("");
        return;
      }

      const data = await res.json();
      const baleInfo = data.baleInfo;
      const product = data.product;
      const labelPrint = data.labelPrint;

      const articleCode = product?.articleCode || labelPrint?.articleCode || baleInfo?.articleCode || "";
      const productName = baleInfo?.productName || product?.name || "Unknown";
      const weightKg = parseFloat(baleInfo?.weightKg || labelPrint?.approxWeightKg || "0");
      const status = baleInfo?.status || "";
      const isInLoadingOrder = baleInfo?.isInLoadingOrder === true;

      await apiRequest("POST", "/api/factory/ground-scan-items", {
        locationId: selectedLocationId,
        referenceNumber: value,
        articleCode,
        productName,
        weightKg,
        status,
        isInLoadingOrder,
      });

      // apiRequest rejects HTTP errors before returning; handle 409/4xx in the
      // catch below instead of treating every business rejection as a network fault.
      setScanInput("");
      setScanError("");
      toast({ title: "Bale scanned", description: `${productName} — ${status}` });
      invalidate();
    } catch (error) {
      const details = getErrorDetails(error);
      if (details.status === 409) {
        setScanError(`Already scanned: ${value}`);
        setScanInput("");
        toast({ title: "Duplicate scan", description: `${value} is already in the list.`, variant: "destructive" });
      } else if (details.status && details.status < 500) {
        // Show actual validation/permission errors returned by the server.
        setScanError(details.message || `Scan rejected (HTTP ${details.status})`);
        toast({ title: "Scan rejected", description: details.message, variant: "destructive" });
      } else if (details.status) {
        setScanError(`Server error (HTTP ${details.status}) — retry or contact support`);
      } else {
        setScanError("Connection problem — check the network and retry");
      }
    } finally {
      setScanning(false);
      setTimeout(() => scanRef.current?.focus(), 50);
    }
  }

  async function handleMigrateUpload() {
    if (localBales.length === 0) return;
    setUploading(true);
    try {
      const res = await apiRequest("POST", "/api/factory/ground-scan-items/bulk", {
        locationId: selectedLocationId,
        items: localBales,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { inserted, skipped } = await res.json();
      localStorage.removeItem(STORAGE_KEY);
      setLocalBales([]);
      invalidate();
      toast({
        title: "Upload complete",
        description: `${inserted} bales uploaded${skipped > 0 ? `, ${skipped} skipped (duplicates)` : ""}.`,
      });
    } catch (e) {
      toast({ title: "Upload failed", description: getErrorDetails(e).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function handleMigrateDiscard() {
    localStorage.removeItem(STORAGE_KEY);
    setLocalBales([]);
    toast({ title: "Local scans discarded", description: "Your locally stored scans have been cleared." });
  }

  async function exportExcel() {
    if (scannedBales.length === 0) return;
    setExporting(true);
    try {
      return await exportGroundScanWorkbook({ selectedLocationId, scannedBales, stockLocations, totalWeight });
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  return {
    clearMutation,
    exporting,
    hasMigrationData,
    isLoading,
    localBales,
    removeMutation,
    scanError,
    scanInput,
    scanRef,
    scannedBales,
    scanning,
    selectedLocationId,
    serverItems,
    setScanError,
    setScanInput,
    setSelectedLocationId,
    stockLocations,
    totalWeight,
    uploading,
    handleScan,
    handleMigrateUpload,
    handleMigrateDiscard,
    exportExcel,
  };
}

export type GroundScanModel = ReturnType<typeof useGroundScanModel>;
