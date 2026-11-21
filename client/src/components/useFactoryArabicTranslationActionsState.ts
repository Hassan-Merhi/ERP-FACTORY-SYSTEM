// Extracted from ./FactoryArabicTranslationActions.tsx
import { useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { downloadBlob } from "@/lib/downloadBlob";

export type FactoryArabicImportMode = "fill-missing" | "replace-existing";

type PreviewStatus = "update" | "unchanged" | "unknown" | "duplicate" | "invalid" | "category-conflict" | "ambiguous";

interface TranslationPreviewRow {
  rowNumber: number;
  articleCode: string;
  status: PreviewStatus;
  reasons: string[];
}

interface TranslationPreview {
  totalRows: number;
  matchedProducts: number;
  unchangedRows: number;
  rowsToApply: number;
  productsToUpdate: number;
  categoriesToUpdate: number;
  unknownArticleCodes: string[];
  duplicateArticleCodes: string[];
  ambiguousArticleCodes: string[];
  blankOrInvalidArabicNames: number;
  categoryConflicts: number;
  blocked: boolean;
  previewToken: string;
  rows: TranslationPreviewRow[];
}

async function permissionProbe(path: string): Promise<boolean> {
  const response = await fetch(path, {
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error("Permission check failed");
  return true;
}

async function downloadResponse(response: Response, fallbackName: string): Promise<void> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.message || "Download failed");
  }
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("The server returned an empty workbook");
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const fileName = match ? decodeURIComponent(match[1].replace(/"/g, "")) : fallbackName;
  downloadBlob(blob, fileName);
}

function createFormData(file: File, mode: FactoryArabicImportMode, previewToken?: string): FormData {
  const form = new FormData();
  form.append("file", file);
  form.append("mode", mode);
  if (previewToken) form.append("previewToken", previewToken);
  return form;
}

export function useFactoryArabicTranslationActionsState() {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState<FactoryArabicImportMode>("fill-missing");
  const [preview, setPreview] = useState<TranslationPreview | null>(null);
  const [exporting, setExporting] = useState(false);
  const recordChanges = useExistingRecordChangeAccess();

  const { data: canImport = false } = useQuery({
    queryKey: ["/api/factory/bale-products/arabic-import/capabilities/import"],
    queryFn: () => permissionProbe("/api/factory/bale-products/arabic-import/capabilities/import"),
    retry: false,
    staleTime: 60_000,
  });
  const { data: canExport = false } = useQuery({
    queryKey: ["/api/factory/bale-products/arabic-import/capabilities/export"],
    queryFn: () => permissionProbe("/api/factory/bale-products/arabic-import/capabilities/export"),
    retry: false,
    staleTime: 60_000,
  });

  const resetSelection = () => {
    setFile(null);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Choose an .xlsx workbook first");
      const response = await fetch("/api/factory/bale-products/arabic-import/preview", {
        method: "POST",
        credentials: "include",
        body: createFormData(file, mode),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.message || "Preview failed");
      return payload as TranslationPreview;
    },
    onSuccess: setPreview,
    onError: (error: Error) =>
      toast({
        title: "Preview failed",
        description: error.message,
        variant: "destructive",
      }),
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      if (!file || !preview) {
        throw new Error("Preview the workbook before applying it");
      }
      if (preview.blocked) {
        throw new Error("Resolve duplicate article codes, ambiguous catalog codes, and category conflicts first");
      }
      const response = await fetch("/api/factory/bale-products/arabic-import/apply", {
        method: "POST",
        credentials: "include",
        body: createFormData(file, mode, preview.previewToken),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (payload.preview?.previewToken) {
          setPreview(payload.preview as TranslationPreview);
        }
        throw new Error(payload.message || "Import failed");
      }
      return payload;
    },
    onSuccess: async (result) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/bale-products"],
          exact: false,
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/categories"],
          exact: false,
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/factory/bale-products/lookup"],
          exact: false,
          refetchType: "active",
        }),
        queryClient.invalidateQueries({
          queryKey: ["/api/bale-products"],
          exact: false,
          refetchType: "active",
        }),
      ]);
      toast({
        title: "Arabic translations updated",
        description: `${result.changedProductIds?.length || 0} products and ${result.changedCategoryIds?.length || 0} categories changed.`,
      });
      setOpen(false);
      resetSelection();
    },
    onError: (error: Error) =>
      toast({
        title: "Import failed",
        description: error.message,
        variant: "destructive",
      }),
  });

  const exportTemplate = async () => {
    setExporting(true);
    try {
      await downloadResponse(
        await fetch("/api/factory/bale-products/arabic-template", {
          credentials: "include",
          cache: "no-store",
        }),
        "factory-arabic-names-template.xlsx"
      );
    } catch (error) {
      toast({
        title: "Export failed",
        description: (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const downloadErrors = async () => {
    if (!file) return;
    try {
      await downloadResponse(
        await fetch("/api/factory/bale-products/arabic-import/errors", {
          method: "POST",
          credentials: "include",
          body: createFormData(file, mode),
        }),
        "factory-arabic-import-errors.xlsx"
      );
    } catch (error) {
      toast({
        title: "Export failed",
        description: (error as Error).message,
        variant: "destructive",
      });
    }
  };
  return {
    toast,
    inputRef,
    setOpen,
    open,
    setFile,
    file,
    mode,
    setMode,
    preview,
    setPreview,
    exporting,
    recordChanges,
    canImport,
    canExport,
    resetSelection,
    previewMutation,
    applyMutation,
    exportTemplate,
    downloadErrors,
  };
}
