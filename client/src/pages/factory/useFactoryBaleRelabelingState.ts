// Extracted from ./FactoryBaleRelabeling.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useRef, useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useDateFormat } from "@/contexts/DateFormatContext";
import {
  type A4DesignColor,
  generateA5LabelsHtml,
  generateCombinedLabelsHtml,
  generateStickerLabelsHtml,
  type LabelData,
  prefetchBannersForPrint,
} from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";
import { preparePriorityPrintLabels } from "@/lib/priorityPrintPreflight";
import type { ApplyItem, ParsedRow, RelabelSession, Step, ValidationResult } from "./factorybalerelabeling/types";
import { parseExcelFile } from "./factorybalerelabeling/utils";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

export function useFactoryBaleRelabelingState() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const fileRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState("");

  const [validationResults, setValidationResults] = useState<ValidationResult[]>([]);
  const [printFormats, setPrintFormats] = useState<Set<"A4" | "A5" | "STICKER">>(new Set(["A4"]));
  const [designColor, setDesignColor] = useState<A4DesignColor>("purple");
  const { colors } = useLabelDesignColors();
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: companyQueryKey("/api/factory/my-access", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    staleTime: 5 * 60000,
  });
  const hiddenTabs =
    myAccess?.companyId === selectedCompany?.id && myAccess?.hasFactoryAccess === true
      ? myAccess.hiddenCostFields
      : ["hide_tab_relabeling_main", "hide_tab_relabeling_wipers"];
  const showRelabeling = !hiddenTabs.includes("hide_tab_relabeling_main");
  const showWipersReEntry = !hiddenTabs.includes("hide_tab_relabeling_wipers");

  const toggleFormat = (fmt: "A4" | "A5" | "STICKER") => {
    setPrintFormats((prev) => {
      const next = new Set(prev);
      if (next.has(fmt)) {
        if (next.size === 1) return prev;
        next.delete(fmt);
      } else {
        next.add(fmt);
      }
      return next;
    });
  };

  const printFormatLabel = Array.from(printFormats).join("+");

  const [applyResult, setApplyResult] = useState<{ sessionId: number; items: ApplyItem[] } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showLabelPreview, setShowLabelPreview] = useState(true);

  const validRows = validationResults.filter((r) => r.valid);
  const invalidRows = validationResults.filter((r) => !r.valid);

  const { data: sessions = [] } = useQuery<RelabelSession[]>({
    queryKey: companyQueryKey("/api/factory/bales/relabel/sessions", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/bales/relabel/sessions");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const validateMutation = useMutation({
    mutationFn: async (rows: ParsedRow[]) => {
      const res = await factoryApiRequest("POST", "/api/factory/bales/relabel/validate", {
        rows: rows.map((r) => ({ currentRef: r.currentRef })),
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      setValidationResults(data.results);
      setStep("validate");
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Validation failed", description: e.message, variant: "destructive" });
    },
  });

  const applyMutation = useMutation({
    mutationFn: async () => {
      const res = await factoryApiRequest("POST", "/api/factory/bales/relabel/apply", {
        rows: validRows.map((r) => ({ currentRef: r.currentRef })),
        printFormat: printFormatLabel,
        designColor: printFormats.has("A4") ? designColor : undefined,
        filename: fileName,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message);
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/relabel/sessions"], refetchType: "active" });
      setApplyResult(data);
      setStep("done");
      toast({ title: "Relabeling applied", description: `${data.items.length} bales recoded successfully` });
    },
    onError: (e: ClientErrorLike) => {
      if (e?._handledGlobally) return;
      toast({ title: "Apply failed", description: e.message, variant: "destructive" });
    },
  });

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setParseError("");
    setParsedRows([]);
    try {
      const rows = await parseExcelFile(file);
      setParsedRows(rows);
    } catch (err) {
      setParseError(getErrorDetails(err).message);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const handlePrint = async () => {
    if (!applyResult) return;
    const labels: LabelData[] = applyResult.items.map((item) => ({
      referenceNumber: item.newRef,
      articleCode: item.articleCode || "",
      pieces: 1,
      approxWeightKg: item.weightKg || "0",
      productName: item.productName || "",
    }));

    let preparedLabels: LabelData[];
    try {
      preparedLabels = await preparePriorityPrintLabels(labels, factoryApiRequest);
    } catch (error) {
      toast({ title: "Priority printing failed", description: getErrorDetails(error).message, variant: "destructive" });
      return;
    }

    prefetchBannersForPrint();
    let opened = 0;
    const formatsToOpen = Array.from(printFormats);
    for (const fmt of formatsToOpen) {
      let html: string;
      if (fmt === "A4") html = generateCombinedLabelsHtml(preparedLabels, designColor);
      else if (fmt === "A5") html = generateA5LabelsHtml(preparedLabels);
      else html = generateStickerLabelsHtml(preparedLabels);

      const win = window.open("", "_blank");
      if (!win) {
        toast({ title: "Popup blocked", description: "Allow popups to print labels", variant: "destructive" });
        return;
      }
      win.document.write(html);
      win.document.close();
      const delay = opened * 600;
      setTimeout(() => win.print(), 500 + delay);
      opened++;
    }
  };

  const handleReset = () => {
    setStep("upload");
    setFileName("");
    setParsedRows([]);
    setParseError("");
    setValidationResults([]);
    setApplyResult(null);
  };

  const [, navigate] = useLocation();
  return {
    applyMutation,
    applyResult,
    colors,
    designColor,
    fileName,
    fileRef,
    formatDisplayDate,
    handleFileSelect,
    handlePrint,
    handleReset,
    invalidRows,
    navigate,
    parseError,
    parsedRows,
    printFormatLabel,
    printFormats,
    sessions,
    setDesignColor,
    setShowHistory,
    setShowLabelPreview,
    showHistory,
    showLabelPreview,
    showRelabeling,
    showWipersReEntry,
    step,
    toggleFormat,
    validRows,
    validateMutation,
    validationResults,
  };
}
