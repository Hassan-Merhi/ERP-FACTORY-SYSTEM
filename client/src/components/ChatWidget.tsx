import { toast } from "@/hooks/use-toast";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MessageCircle,
  X,
  Eraser,
  Maximize2,
  Minimize2,
  MinimizeIcon,
  Circle,
  Sparkles,
  ChevronDown,
  ChevronRight,
  FileCode,
  Package,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";

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

import { AlertsDigest } from "./chat-widget/AlertsDigest";
import { ChatMessageList } from "./chat-widget/ChatMessageList";
import { ChatWidgetInput } from "./chat-widget/ChatWidgetInput";
import { useChatActions } from "./chat-widget/useChatActions";

export function ChatWidget() {
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
    const newId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
      const resp = await fetch("/api/chatbot/confirm-po-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(resolved),
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

  const handleClearChat = () => {
    if (
      hasPendingDrafts &&
      !window.confirm("You have a pending action that hasn't been confirmed yet. Clear chat and discard it?")
    ) {
      return;
    }
    handleNewChat();
  };

  const handleNewChat = () => {
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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

  if (!status || !status.enabled || !status.hasApiKey) return null;

  const defaultSuggestions = [
    "Give me a business summary",
    "What items are low on stock?",
    "Show my top selling products",
    "What are my outstanding payments?",
  ];
  // Suggestion chips are only useful on a brand-new, empty chat — once the
  // user has sent a message, gotten a response, or has any pending
  // draft/card on screen, showing them again just wastes space.
  const isChatEmpty =
    history.length === 0 &&
    !pendingVoucher &&
    !pendingStockAdj &&
    !pendingStockTransfer &&
    !(pendingStockTransferBatch && pendingStockTransferBatch.length > 0) &&
    !pendingStockItem &&
    !pendingPriceUpdate &&
    !accountQueryResult &&
    !poDraft &&
    !verifyContainerDraft &&
    !dataQueryResult &&
    pendingFilePatches.length === 0;
  const displaySuggestions = isChatEmpty ? (suggestions.length > 0 ? suggestions : defaultSuggestions) : [];

  const formatMsgTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  const pageContext = (() => {
    const p = location;
    if (p.startsWith("/factory")) return "Factory";
    if (p.startsWith("/pos")) return "POS";
    if (p.startsWith("/properties")) return "Properties";
    if (p.startsWith("/inventory")) return "Inventory";
    if (p.startsWith("/accounts")) return "Accounts";
    if (p.startsWith("/reports")) return "Reports";
    if (p.startsWith("/customers")) return "Customers";
    if (p.startsWith("/suppliers")) return "Suppliers";
    if (p.startsWith("/vouchers")) return "Vouchers";
    return "Dashboard";
  })();

  const showFullscreen = isOpen && isFullscreen && !isMinimized;

  return (
    <div
      className={cn("fixed z-50", showFullscreen ? "inset-0 flex items-center justify-center" : "bottom-4 right-4")}
      data-testid="chat-widget-container"
    >
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          data-testid="button-open-chat"
          className="group flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-md
            px-3 py-2 opacity-30 hover:opacity-100
            transition-all duration-300 ease-in-out
            overflow-hidden max-w-[2.25rem] hover:max-w-[160px]"
        >
          <MessageCircle className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity duration-200 delay-100">
            AI Assistant
          </span>
        </button>
      ) : isMinimized ? (
        <div
          className="relative flex items-center gap-1 rounded-full bg-card border shadow-lg hover:shadow-xl transition-shadow pl-1 pr-1 py-1"
          data-testid="chat-minimized-bar"
        >
          <button
            type="button"
            onClick={handleRestoreFromMinimized}
            data-testid="button-restore-chat"
            title="Reopen chat"
            className="flex items-center gap-3 rounded-full pl-2 pr-1 py-1"
          >
            <div className="h-8 w-8 rounded-full bg-blue-50 dark:bg-blue-900/40 flex items-center justify-center shrink-0">
              <Sparkles className="h-4 w-4 text-blue-500 dark:text-blue-400" />
            </div>
            <div className="text-left pr-1">
              <p className="text-sm font-medium leading-tight">ERP Assistant</p>
              <div className="flex items-center gap-1.5">
                <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
                <span className="text-xs text-muted-foreground">
                  {hasNewSinceMinimized ? "New response" : "Online"}
                </span>
              </div>
            </div>
          </button>
          {hasNewSinceMinimized && (
            <span
              className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 border-2 border-background"
              data-testid="indicator-unread-chat"
            />
          )}
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              setIsMinimized(false);
              setHasNewSinceMinimized(false);
            }}
            className="h-6 w-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0"
            data-testid="button-close-minimized-chat"
            title="Close chat"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <Card
          className={cn(
            "shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.4)] transition-all duration-200 flex flex-col overflow-hidden",
            isFullscreen
              ? "w-screen h-screen sm:w-[90vw] sm:h-[90vh] sm:max-w-6xl rounded-none sm:rounded-3xl"
              : "w-[calc(100vw-24px)] h-[calc(100vh-24px)] sm:w-[580px] sm:h-[80vh] sm:max-h-[760px] rounded-3xl"
          )}
        >
          <CardHeader className="flex flex-row items-center justify-between gap-2 py-4 px-5 border-b shrink-0">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-full bg-blue-50 dark:bg-blue-900/40 flex items-center justify-center">
                <Sparkles className="h-4 w-4 text-blue-500 dark:text-blue-400" />
              </div>
              <div>
                <CardTitle className="text-sm font-medium">ERP Assistant</CardTitle>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <Circle className="h-1.5 w-1.5 fill-green-500 text-green-500" />
                  <p className="text-xs text-muted-foreground">Online</p>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={handleClearChat}
                title="Clear chat"
                data-testid="button-clear-chat"
              >
                <Eraser className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => setIsFullscreen(!isFullscreen)}
                title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                data-testid="button-fullscreen-chat"
              >
                {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => setIsMinimized(true)}
                title="Minimize"
                data-testid="button-minimize-chat"
              >
                <MinimizeIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => setIsOpen(false)}
                title="Close"
                data-testid="button-close-chat"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>

          <div className="px-5 pt-2.5 pb-1 bg-background shrink-0">
            <Badge
              variant="secondary"
              className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-blue-800 font-medium px-2 py-0.5 flex items-center gap-1.5 w-fit text-[11px]"
            >
              <Package className="h-3 w-3" />
              Context: {pageContext}
            </Badge>
          </div>

          <CardContent className="p-0 flex flex-col flex-1 overflow-hidden">
            {showAlerts && (
              <AlertsDigest
                onClose={() => setShowAlerts(false)}
                onPrefill={(text) => {
                  setMessage(text);
                  inputRef.current?.focus();
                }}
              />
            )}

            <ChatMessageList
              history={history}
              isPending={sendMutation.isPending}
              displaySuggestions={displaySuggestions}
              handleSuggestionClick={(s) => handleSend(s)}
              formatMsgTime={formatMsgTime}
              feedbackGiven={feedbackGiven}
              handleFeedback={handleFeedback}
              lastUsedProvider={lastUsedProvider}
              pendingVoucher={pendingVoucher}
              handleConfirmVoucher={handleConfirmVoucher}
              setPendingVoucher={setPendingVoucher}
              voucherSubmitting={voucherSubmitting}
              pendingStockTransfer={pendingStockTransfer}
              handleConfirmStockTransfer={handleConfirmStockTransfer}
              setPendingStockTransfer={setPendingStockTransfer}
              stockTransferSubmitting={stockTransferSubmitting}
              pendingStockTransferBatch={pendingStockTransferBatch}
              handleConfirmStockTransferBatchItem={handleConfirmStockTransferBatchItem}
              handleDismissStockTransferBatchItem={handleDismissStockTransferBatchItem}
              pendingStockAdj={pendingStockAdj}
              handleConfirmStockAdj={handleConfirmStockAdj}
              setPendingStockAdj={setPendingStockAdj}
              stockAdjSubmitting={stockAdjSubmitting}
              voucherSearchResults={voucherSearchResults}
              setVoucherSearchResults={setVoucherSearchResults}
              pendingStockItem={pendingStockItem}
              handleConfirmStockItem={handleConfirmStockItem}
              setPendingStockItem={setPendingStockItem}
              stockItemSubmitting={stockItemSubmitting}
              pendingPriceUpdate={pendingPriceUpdate}
              handleConfirmPriceUpdate={handleConfirmPriceUpdate}
              setPendingPriceUpdate={setPendingPriceUpdate}
              priceUpdateSubmitting={priceUpdateSubmitting}
              accountQueryResult={accountQueryResult}
              setAccountQueryResult={setAccountQueryResult}
              poDraft={poDraft}
              handleConfirmPOImport={handleConfirmPOImport}
              setPoDraft={setPoDraft}
              poDraftSubmitting={poDraftSubmitting}
              poDraftResult={poDraftResult}
              poDraftError={poDraftError}
              setPoDraftResult={setPoDraftResult}
              setPoDraftError={setPoDraftError}
              verifyContainerDraft={verifyContainerDraft}
              setVerifyContainerDraft={setVerifyContainerDraft}
              dataQueryResult={dataQueryResult}
              setDataQueryResult={setDataQueryResult}
              pendingFilePatches={pendingFilePatches}
              setPendingFilePatches={setPendingFilePatches}
              appliedPatchFiles={appliedPatchFiles}
              setAppliedPatchFiles={setAppliedPatchFiles}
              patchApplying={patchApplying}
              handleApplyPatch={handleApplyPatch}
              handleApplyAllPatches={handleApplyAllPatches}
              handleGitPush={handleGitPush}
              gitPushing={gitPushing}
              perFilePushResult={perFilePushResult}
              setPerFilePushResult={setPerFilePushResult}
              scrollAreaRef={scrollAreaRef}
            />

            {sessionReadFiles.length > 0 && (
              <div className="px-4 pb-1 border-b border-border/40">
                <button
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
                  onClick={() => setShowSessionFiles((v) => !v)}
                >
                  {showSessionFiles ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <FileCode className="h-3 w-3" />
                  {sessionReadFiles.length} file{sessionReadFiles.length !== 1 ? "s" : ""} read this session
                </button>
                {showSessionFiles && (
                  <div className="flex flex-wrap gap-1 pb-1">
                    {sessionReadFiles.map((fp) => (
                      <span
                        key={fp}
                        className="inline-flex items-center gap-1 text-[10px] font-mono bg-muted rounded px-1.5 py-0.5 text-muted-foreground"
                      >
                        <FileCode className="h-2.5 w-2.5 shrink-0" />
                        {fp.replace(/^.*\//, "")}
                      </span>
                    ))}
                    <button
                      className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors px-1"
                      onClick={() => {
                        setSessionReadFiles([]);
                        setShowSessionFiles(false);
                      }}
                    >
                      clear
                    </button>
                  </div>
                )}
              </div>
            )}

            <ChatWidgetInput
              fileInputRef={fileInputRef}
              handleFileSelect={handleFileSelect}
              poDraftUploading={poDraftUploading}
              isPending={sendMutation.isPending}
              inputRef={inputRef}
              message={message}
              setMessage={setMessage}
              handleKeyDown={handleKeyDown}
              handleSend={handleSend}
              isError={sendMutation.isError}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
