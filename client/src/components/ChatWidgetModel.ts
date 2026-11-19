// Extracted from ./ChatWidget.tsx: state, queries and handlers for ChatWidget.
import { toast } from "@/hooks/use-toast";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ChatStatus,
  ChatMessage,
  VoucherDraft,
  StockAdjustmentDraft,
  StockTransferDraft,
  StockItemDraft,
  PriceUpdateDraft,
  POImportDraft,
  POImportResult,
  FilePatchDraft,
  PushResult,
  VoucherSearchResult,
  AccountQueryResult,
  VerifyContainerDraft,
  DataQueryResult,
} from "./chat-widget/chatWidgetTypes";
import { useChatActions } from "./chat-widget/useChatActions";
import { confirmAction } from "@/components/ConfirmHost";

export function useChatWidgetModel() {
  const [isOpen, setIsOpen] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasNewSinceMinimized, setHasNewSinceMinimized] = useState(false);
  const prevHistoryLenRef = useRef(0);
  const [message, setMessage] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [feedbackGiven, setFeedbackGiven] = useState<Record<number, "positive" | "negative">>({});
  const [sessionId, setSessionId] = useState(() => {
    const stored = localStorage.getItem("erp_chat_session");
    if (stored) return stored;
    const newId = `session_${Date.now()}_${crypto.randomUUID()}`;
    localStorage.setItem("erp_chat_session", newId);
    return newId;
  });
  const [showAlerts, setShowAlerts] = useState(true);
  const [pendingVoucher, setPendingVoucher] = useState<VoucherDraft | null>(null);
  const [voucherSubmitting, setVoucherSubmitting] = useState(false);
  const [pendingStockAdj, setPendingStockAdj] = useState<StockAdjustmentDraft | null>(null);
  const [stockAdjSubmitting, setStockAdjSubmitting] = useState(false);
  const [voucherSearchResults, setVoucherSearchResults] = useState<VoucherSearchResult[] | null>(null);
  const [pendingStockItem, setPendingStockItem] = useState<StockItemDraft | null>(null);
  const [stockItemSubmitting, setStockItemSubmitting] = useState(false);
  const [pendingPriceUpdate, setPendingPriceUpdate] = useState<PriceUpdateDraft | null>(null);
  const [priceUpdateSubmitting, setPriceUpdateSubmitting] = useState(false);
  const [accountQueryResult, setAccountQueryResult] = useState<AccountQueryResult | null>(null);
  const [poDraft, setPoDraft] = useState<POImportDraft | null>(null);
  const [poDraftUploading, setPoDraftUploading] = useState(false);
  const [poDraftSubmitting, setPoDraftSubmitting] = useState(false);
  const [poDraftResult, setPoDraftResult] = useState<POImportResult | null>(null);
  const [poDraftError, setPoDraftError] = useState<string | null>(null);
  const [verifyContainerDraft, setVerifyContainerDraft] = useState<VerifyContainerDraft | null>(null);
  const [dataQueryResult, setDataQueryResult] = useState<DataQueryResult | null>(null);
  const [pendingStockTransfer, setPendingStockTransfer] = useState<StockTransferDraft | null>(null);
  const [pendingStockTransferBatch, setPendingStockTransferBatch] = useState<StockTransferDraft[] | null>(null);
  const [stockTransferSubmitting, setStockTransferSubmitting] = useState(false);
  const [lastUsedProvider, setLastUsedProvider] = useState<string | null>(null);
  const [pendingFilePatches, setPendingFilePatches] = useState<FilePatchDraft[]>([]);
  const [patchApplying, setPatchApplying] = useState<string | null>(null);
  const [appliedPatchFiles, setAppliedPatchFiles] = useState<Set<string>>(new Set());
  const [gitPushing, setGitPushing] = useState(false);
  const [perFilePushResult, setPerFilePushResult] = useState<Record<string, PushResult>>({});
  const [sessionReadFiles, setSessionReadFiles] = useState<string[]>([]);
  const [showSessionFiles, setShowSessionFiles] = useState(false);
  const [location] = useLocation();

  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();

  const { data: status } = useQuery<ChatStatus>({
    queryKey: ["/api/chatbot/status"],
  });

  const { data: history = [], refetch: refetchHistory } = useQuery<ChatMessage[]>({
    queryKey: [`/api/chatbot/history/${sessionId}`],
    enabled: isOpen && status?.enabled && status?.hasApiKey,
  });

  const {
    sendMutation,
    handleConfirmVoucher: _handleConfirmVoucher,
    handleConfirmStockTransfer: _handleConfirmStockTransfer,
    handleConfirmStockAdj: _handleConfirmStockAdj,
    handleConfirmStockItem: _handleConfirmStockItem,
    handleConfirmPriceUpdate: _handleConfirmPriceUpdate,
    handleApplyPatch: _handleApplyPatch,
    handleApplyAllPatches,
    handleGitPush: _handleGitPush,
  } = useChatActions({
    sessionId,
    location,
    sessionReadFiles,
    setMessage,
    setLastUsedProvider,
    setSuggestions,
    setPendingVoucher,
    setPendingStockAdj,
    setPendingStockTransfer,
    setPendingStockTransferBatch,
    setVoucherSearchResults,
    setPendingStockItem,
    setPendingPriceUpdate,
    setAccountQueryResult,
    setVerifyContainerDraft,
    setDataQueryResult,
    setPendingFilePatches,
    setAppliedPatchFiles: (fn) => setAppliedPatchFiles(fn),
    setPerFilePushResult: (fn) => setPerFilePushResult(fn),
    setSessionReadFiles,
    refetchHistory,
    pendingFilePatches,
    appliedPatchFiles,
  });

  const handleConfirmVoucher = async (edited: VoucherDraft) => {
    setVoucherSubmitting(true);
    try {
      await _handleConfirmVoucher(edited);
    } finally {
      setVoucherSubmitting(false);
    }
  };
  const handleConfirmStockTransfer = async (resolved: StockTransferDraft) => {
    setStockTransferSubmitting(true);
    try {
      await _handleConfirmStockTransfer(resolved);
    } finally {
      setStockTransferSubmitting(false);
    }
  };
  // Multiple source drafts (e.g. "410 bales to Kolwezi from Hadi 1,2,3,4") render
  // as separate cards; confirming/dismissing one only removes that one entry.
  const handleConfirmStockTransferBatchItem = async (index: number, resolved: StockTransferDraft) => {
    setStockTransferSubmitting(true);
    try {
      await _handleConfirmStockTransfer(resolved);
      setPendingStockTransferBatch((prev) => {
        if (!prev) return prev;
        const next = prev.filter((_, i) => i !== index);
        return next.length > 0 ? next : null;
      });
    } finally {
      setStockTransferSubmitting(false);
    }
  };
  const handleDismissStockTransferBatchItem = (index: number) => {
    setPendingStockTransferBatch((prev) => {
      if (!prev) return prev;
      const next = prev.filter((_, i) => i !== index);
      return next.length > 0 ? next : null;
    });
  };
  const handleConfirmStockAdj = async (resolved: StockAdjustmentDraft) => {
    setStockAdjSubmitting(true);
    try {
      await _handleConfirmStockAdj(resolved);
    } finally {
      setStockAdjSubmitting(false);
    }
  };
  const handleConfirmStockItem = async (resolved: StockItemDraft) => {
    setStockItemSubmitting(true);
    try {
      await _handleConfirmStockItem(resolved);
    } finally {
      setStockItemSubmitting(false);
    }
  };
  const handleConfirmPriceUpdate = async (resolved: PriceUpdateDraft) => {
    setPriceUpdateSubmitting(true);
    try {
      await _handleConfirmPriceUpdate(resolved);
    } finally {
      setPriceUpdateSubmitting(false);
    }
  };
  const handleApplyPatch = async (patch: FilePatchDraft) => {
    setPatchApplying(patch.filePath);
    try {
      await _handleApplyPatch(patch);
    } finally {
      setPatchApplying(null);
    }
  };
  const handleGitPush = async (filePath: string, commitMsg: string) => {
    setGitPushing(true);
    try {
      await _handleGitPush(filePath, commitMsg);
    } finally {
      setGitPushing(false);
    }
  };

  useEffect(() => {
    if (scrollAreaRef.current) {
      const sc = scrollAreaRef.current.querySelector("[data-radix-scroll-area-viewport]");
      if (sc) sc.scrollTop = sc.scrollHeight;
    }
  }, [history, sendMutation.isPending]);

  useEffect(() => {
    if (isOpen && inputRef.current && !isMinimized) inputRef.current.focus();
  }, [isOpen, isMinimized]);

  useEffect(() => {
    if (isMinimized && history.length > prevHistoryLenRef.current) {
      const last = history[history.length - 1];
      if (last?.role === "assistant") setHasNewSinceMinimized(true);
    }
    prevHistoryLenRef.current = history.length;
  }, [history, isMinimized]);

  const handleRestoreFromMinimized = () => {
    setIsMinimized(false);
    setHasNewSinceMinimized(false);
  };

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setIsOpen(true);
      setIsMinimized(false);
      if (detail?.prefill) {
        setMessage(detail.prefill);
        setTimeout(() => inputRef.current?.focus(), 80);
      }
    };
    window.addEventListener("openAIChat", handler);
    return () => window.removeEventListener("openAIChat", handler);
  }, []);

  const handleSend = (msg?: string) => {
    const textToSend = msg || message.trim();
    if (!textToSend || sendMutation.isPending) return;
    sendMutation.mutate(textToSend);
    if (!msg) setMessage("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFeedback = async (messageId: number, type: "positive" | "negative") => {
    setFeedbackGiven((prev) => ({ ...prev, [messageId]: type }));
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setPoDraftUploading(true);
    setPoDraft(null);
    setPoDraftResult(null);
    setPoDraftError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch("/api/chatbot/parse-po-file", {
        method: "POST",
        body: formData,
        credentials: "include",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || "Failed to parse file");
      setPoDraft(data as POImportDraft);
    } catch (err) {
      toast({ title: "Could not parse file", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setPoDraftUploading(false);
    }
  };

  const handleConfirmPOImport = async (resolved: unknown) => {
    setPoDraftSubmitting(true);
    setPoDraftError(null);
    try {
      let submission = resolved;
      const parsed = resolved as { currency?: string; importDate?: string; exchangeRate?: string };
      if (parsed && String(parsed.currency).toUpperCase() === "ZMW") {
        if (!parsed.importDate) throw new Error("A dated native Kwacha purchase is required.");
        // Resolve the approved rate at confirmation, never infer a current
        // exchange rate or silently multiply Kwacha as dollars.
        const lookup = await fetch(
          `/api/exchange-rates/latest?fromCurrency=USD&toCurrency=ZMW&asOf=${encodeURIComponent(parsed.importDate)}`,
          { credentials: "include" }
        );
        if (!lookup.ok) throw new Error("Could not verify the approved USD/ZMW rate.");
        const rate = (await lookup.json()) as { rate?: string } | null;
        if (!rate?.rate) throw new Error("An approved historical USD/ZMW rate is required for this purchase.");
        submission = { ...parsed, exchangeRate: rate.rate };
      }
      const resp = await fetch("/api/chatbot/confirm-po-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(submission),
        credentials: "include",
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || "Import failed");
      setPoDraftResult(data as POImportResult);
    } catch (err) {
      setPoDraftError(getErrorDetails(err).message);
    } finally {
      setPoDraftSubmitting(false);
    }
  };

  const hasPendingDrafts = Boolean(
    pendingVoucher ||
    pendingStockAdj ||
    pendingStockTransfer ||
    (pendingStockTransferBatch && pendingStockTransferBatch.length > 0) ||
    pendingStockItem ||
    pendingPriceUpdate ||
    poDraft ||
    pendingFilePatches.length > 0
  );

  const handleClearChat = async () => {
    if (
      hasPendingDrafts &&
      !(await confirmAction({
        title: "You have a pending action that hasn't been confirmed yet. Clear chat and discard it?",
        tone: "destructive",
      }))
    ) {
      return;
    }
    handleNewChat();
  };

  const handleNewChat = () => {
    const newSessionId = `session_${Date.now()}_${crypto.randomUUID()}`;
    localStorage.setItem("erp_chat_session", newSessionId);
    queryClient.removeQueries({ queryKey: [`/api/chatbot/history/${sessionId}`] });
    setSessionId(newSessionId);
    setSessionReadFiles([]);
    setShowSessionFiles(false);
    setSuggestions([]);
    setFeedbackGiven({});
    setPendingVoucher(null);
    setPendingStockAdj(null);
    setPendingStockTransfer(null);
    setPendingStockTransferBatch(null);
    setVoucherSearchResults(null);
    setPendingStockItem(null);
    setPendingPriceUpdate(null);
    setAccountQueryResult(null);
    setPoDraft(null);
    setPoDraftResult(null);
    setPoDraftError(null);
    setVerifyContainerDraft(null);
    setDataQueryResult(null);
    setPendingFilePatches([]);
    setAppliedPatchFiles(new Set());
    setPerFilePushResult({});
    setShowAlerts(true);
  };

  return {
    isOpen,
    setIsOpen,
    isMinimized,
    setIsMinimized,
    isFullscreen,
    setIsFullscreen,
    hasNewSinceMinimized,
    setHasNewSinceMinimized,
    message,
    setMessage,
    suggestions,
    feedbackGiven,
    showAlerts,
    setShowAlerts,
    pendingVoucher,
    setPendingVoucher,
    voucherSubmitting,
    pendingStockAdj,
    setPendingStockAdj,
    stockAdjSubmitting,
    voucherSearchResults,
    setVoucherSearchResults,
    pendingStockItem,
    setPendingStockItem,
    stockItemSubmitting,
    pendingPriceUpdate,
    setPendingPriceUpdate,
    priceUpdateSubmitting,
    accountQueryResult,
    setAccountQueryResult,
    poDraft,
    setPoDraft,
    poDraftUploading,
    poDraftSubmitting,
    poDraftResult,
    setPoDraftResult,
    poDraftError,
    setPoDraftError,
    verifyContainerDraft,
    setVerifyContainerDraft,
    dataQueryResult,
    setDataQueryResult,
    pendingStockTransfer,
    setPendingStockTransfer,
    pendingStockTransferBatch,
    stockTransferSubmitting,
    lastUsedProvider,
    pendingFilePatches,
    setPendingFilePatches,
    patchApplying,
    appliedPatchFiles,
    setAppliedPatchFiles,
    gitPushing,
    perFilePushResult,
    setPerFilePushResult,
    sessionReadFiles,
    setSessionReadFiles,
    showSessionFiles,
    setShowSessionFiles,
    location,
    scrollAreaRef,
    inputRef,
    fileInputRef,
    status,
    history,
    sendMutation,
    handleApplyAllPatches,
    handleConfirmVoucher,
    handleConfirmStockTransfer,
    handleConfirmStockTransferBatchItem,
    handleDismissStockTransferBatchItem,
    handleConfirmStockAdj,
    handleConfirmStockItem,
    handleConfirmPriceUpdate,
    handleApplyPatch,
    handleGitPush,
    handleRestoreFromMinimized,
    handleSend,
    handleKeyDown,
    handleFeedback,
    handleFileSelect,
    handleConfirmPOImport,
    handleClearChat,
  };
}

export type ChatWidgetModel = ReturnType<typeof useChatWidgetModel>;
