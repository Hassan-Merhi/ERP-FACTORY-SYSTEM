// Extracted from ./useFactorySettingsModel.ts to keep that module under the source-size cap.
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import type { FactorySettingsData, RenamePreviewItem } from "./types";
import { defaultSettings } from "./utils";
import { factoryRenameDefaults } from "@shared/factoryUiDefaults";
import { useCompany } from "@/contexts/CompanyContext";
import type { OcContainer, BaleValidationResult } from "./useFactorySettingsModelPart1Types";

export function useFactorySettingsModelPart1() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";
  const [settings, setSettings] = useState<FactorySettingsData>(defaultSettings);

  const [prodWaGroupId, setProdWaGroupId] = useState("");
  const [prodWaSearch, setProdWaSearch] = useState("");
  const [prodWaPickerOpen, setProdWaPickerOpen] = useState(false);
  const [weeklyWaGroupId, setWeeklyWaGroupId] = useState("");
  const [weeklyWaSearch, setWeeklyWaSearch] = useState("");
  const [weeklyWaPickerOpen, setWeeklyWaPickerOpen] = useState(false);
  const [attendanceWaGroupId, setAttendanceWaGroupId] = useState("");
  const [attendanceWaSearch, setAttendanceWaSearch] = useState("");
  const [attendanceWaPickerOpen, setAttendanceWaPickerOpen] = useState(false);

  const initialRenameDefaults = factoryRenameDefaults();
  const [codePrefix, setCodePrefix] = useState(initialRenameDefaults.codePrefix);
  const [findStr, setFindStr] = useState(initialRenameDefaults.find);
  const [replaceStr, setReplaceStr] = useState(initialRenameDefaults.replace);
  const [renamePreview, setRenamePreview] = useState<RenamePreviewItem[] | null>(null);

  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [excelResult, setExcelResult] = useState<{
    created: number;
    updated: number;
    categoriesCreated: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [baleImportFile, setBaleImportFile] = useState<File | null>(null);
  const [baleImportResult, setBaleImportResult] = useState<{
    totalBalesCreated: number;
    skippedRows: number;
    skippedDetails: string[];
  } | null>(null);
  const baleFileInputRef = useRef<HTMLInputElement>(null);
  const [baleImportLocationId, setBaleImportLocationId] = useState("");
  const [baleValidationResult, setBaleValidationResult] = useState<BaleValidationResult | null>(null);

  const [ocPreview, setOcPreview] = useState<OcContainer[] | null>(null);
  const [ocFixResult, setOcFixResult] = useState<{ fixed: number } | null>(null);

  const ocPreviewMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/admin/other-charges-currency-preview");
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed");
      }
      return res.json() as Promise<{ containers: OcContainer[] }>;
    },
    onSuccess: (data) => {
      setOcPreview(data.containers);
      setOcFixResult(null);
      if (data.containers.length === 0) {
        toast({ title: "All clear", description: "No other charges found with non-USD currency." });
      }
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Preview failed", description: error.message, variant: "destructive" });
    },
  });

  const ocFixMutation = useMutation({
    mutationFn: async (containerIds: number[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/admin/fix-other-charges-currency", { containerIds });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Failed");
      }
      return res.json() as Promise<{ fixed: number }>;
    },
    onSuccess: (data) => {
      setOcFixResult(data);
      setOcPreview(null);
      toast({ title: "Fixed", description: `${data.fixed} container(s) re-posted in USD.` });
      queryClient.invalidateQueries({ queryKey: ["/api/reports/net-profit-statement"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats/net-profit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Fix failed", description: error.message, variant: "destructive" });
    },
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", "/api/factory/bale-products/bulk-rename-preview", {
        codePrefix,
        find: findStr,
        replace: replaceStr,
      });
      return res.json();
    },
    onSuccess: (data: { total: number; matches: RenamePreviewItem[] }) => {
      setRenamePreview(data.matches);
      if (data.matches.length === 0) {
        toast({
          title: "No matches",
          description: `Found ${data.total} products with code prefix "${codePrefix}" but none have "${findStr}" in their name.`,
        });
      }
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Preview failed", description: error.message, variant: "destructive" });
    },
  });

  const applyMutation = useMutation({
    mutationFn: async (items: RenamePreviewItem[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/bale-products/bulk-rename-apply", { items });
      return res.json();
    },
    onSuccess: (data: { updated: number }) => {
      toast({ title: "Renamed successfully", description: `${data.updated} product name(s) updated.` });
      setRenamePreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Rename failed", description: error.message, variant: "destructive" });
    },
  });

  const excelUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bale-products/import-excel", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data: { created: number; updated: number; categoriesCreated: number }) => {
      setExcelResult(data);
      setExcelFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-products"] });
      toast({
        title: "Excel import complete",
        description: `${data.updated} updated, ${data.created} created${data.categoriesCreated > 0 ? `, ${data.categoriesCreated} categories created` : ""}`,
      });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });

  const baleValidateMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/factory/bales/validate-import", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Validation failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      setBaleValidationResult(data);
      setBaleImportResult(null);
      if (data.validRows.length === 0) {
        toast({
          title: "No valid rows",
          description: `All ${data.totalRows} rows were skipped. Check the details below.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Validation complete",
          description: `${data.validRows.length} row(s) ready to import (${data.totalBales} bales, ${data.totalWeight.toFixed(1)} kg)`,
        });
      }
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Validation error", description: error.message, variant: "destructive" });
    },
  });

  const baleImportMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      if (baleImportLocationId) formData.append("locationId", baleImportLocationId);
      const res = await fetch("/api/factory/bales/import-excel", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Upload failed");
      }
      return res.json();
    },
    onSuccess: (data: { totalBalesCreated: number; skippedRows: number; skippedDetails: string[] }) => {
      setBaleImportResult(data);
      setBaleValidationResult(null);
      setBaleImportFile(null);
      if (baleFileInputRef.current) baleFileInputRef.current.value = "";
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      toast({
        title: "Bale import complete",
        description: `${data.totalBalesCreated} bale(s) created${data.skippedRows > 0 ? `, ${data.skippedRows} row(s) skipped` : ""}`,
      });
    },
    onError: (error: Error) => {
      if (error?._handledGlobally) return;
      toast({ title: "Import error", description: error.message, variant: "destructive" });
    },
  });
  return {
    applyMutation,
    attendanceWaGroupId,
    attendanceWaPickerOpen,
    attendanceWaSearch,
    baleFileInputRef,
    baleImportFile,
    baleImportLocationId,
    baleImportMutation,
    baleImportResult,
    baleValidateMutation,
    baleValidationResult,
    codePrefix,
    excelFile,
    excelResult,
    excelUploadMutation,
    fileInputRef,
    findStr,
    isDeveloper,
    ocFixMutation,
    ocFixResult,
    ocPreview,
    ocPreviewMutation,
    previewMutation,
    prodWaGroupId,
    prodWaPickerOpen,
    prodWaSearch,
    renamePreview,
    replaceStr,
    selectedCompany,
    setAttendanceWaGroupId,
    setAttendanceWaPickerOpen,
    setAttendanceWaSearch,
    setBaleImportFile,
    setBaleImportLocationId,
    setBaleImportResult,
    setBaleValidationResult,
    setCodePrefix,
    setExcelFile,
    setExcelResult,
    setFindStr,
    setProdWaGroupId,
    setProdWaPickerOpen,
    setProdWaSearch,
    setRenamePreview,
    setReplaceStr,
    setSettings,
    setWeeklyWaGroupId,
    setWeeklyWaPickerOpen,
    setWeeklyWaSearch,
    settings,
    toast,
    weeklyWaGroupId,
    weeklyWaPickerOpen,
    weeklyWaSearch,
  };
}
