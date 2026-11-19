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
import { cn } from "@/lib/utils";

import { AlertsDigest } from "./chat-widget/AlertsDigest";
import { ChatMessageList } from "./chat-widget/ChatMessageList";
import { ChatWidgetInput } from "./chat-widget/ChatWidgetInput";
import { useChatWidgetModel } from "./ChatWidgetModel";

export function ChatWidget() {
  const m = useChatWidgetModel();

  if (!m.status || !m.status.enabled || !m.status.hasApiKey) return null;

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
    m.history.length === 0 &&
    !m.pendingVoucher &&
    !m.pendingStockAdj &&
    !m.pendingStockTransfer &&
    !(m.pendingStockTransferBatch && m.pendingStockTransferBatch.length > 0) &&
    !m.pendingStockItem &&
    !m.pendingPriceUpdate &&
    !m.accountQueryResult &&
    !m.poDraft &&
    !m.verifyContainerDraft &&
    !m.dataQueryResult &&
    m.pendingFilePatches.length === 0;
  const displaySuggestions = isChatEmpty ? (m.suggestions.length > 0 ? m.suggestions : defaultSuggestions) : [];

  const formatMsgTime = (iso: string) => {
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  const pageContext = (() => {
    const p = m.location;
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

  const showFullscreen = m.isOpen && m.isFullscreen && !m.isMinimized;

  return (
    <div
      className={cn("fixed z-50", showFullscreen ? "inset-0 flex items-center justify-center" : "bottom-4 right-4")}
      data-testid="chat-widget-container"
    >
      {!m.isOpen ? (
        <button
          onClick={() => m.setIsOpen(true)}
          data-testid="button-open-chat"
          className="group flex items-center gap-2 rounded-full bg-primary text-primary-foreground shadow-md
            px-3 py-2 opacity-30 hover:opacity-100
            transition-all duration-300 ease-in-out
            overflow-hidden max-w-9 hover:max-w-[160px]"
        >
          <MessageCircle className="h-4 w-4 shrink-0" />
          <span className="text-sm font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 touch:opacity-100 transition-opacity duration-200 delay-100">
            AI Assistant
          </span>
        </button>
      ) : m.isMinimized ? (
        <div
          className="relative flex items-center gap-1 rounded-full bg-card border shadow-lg hover:shadow-xl transition-shadow pl-1 pr-1 py-1"
          data-testid="chat-minimized-bar"
        >
          <button
            type="button"
            onClick={m.handleRestoreFromMinimized}
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
                  {m.hasNewSinceMinimized ? "New response" : "Online"}
                </span>
              </div>
            </div>
          </button>
          {m.hasNewSinceMinimized && (
            <span
              className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-red-500 border-2 border-background"
              data-testid="indicator-unread-chat"
            />
          )}
          <button
            type="button"
            onClick={() => {
              m.setIsOpen(false);
              m.setIsMinimized(false);
              m.setHasNewSinceMinimized(false);
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
            m.isFullscreen
              ? "w-screen h-screen sm:w-[90vw] sm:h-[90vh] sm:max-w-6xl rounded-none sm:rounded-3xl"
              : "w-[calc(100vw-24px)] h-[calc(100dvh-24px)] sm:w-[580px] sm:h-[80vh] sm:max-h-[760px] rounded-3xl"
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
                onClick={m.handleClearChat}
                title="Clear chat"
                data-testid="button-clear-chat"
              >
                <Eraser className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => m.setIsFullscreen(!m.isFullscreen)}
                title={m.isFullscreen ? "Exit fullscreen" : "Fullscreen"}
                data-testid="button-fullscreen-chat"
              >
                {m.isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => m.setIsMinimized(true)}
                title="Minimize"
                data-testid="button-minimize-chat"
              >
                <MinimizeIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full"
                onClick={() => m.setIsOpen(false)}
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
            {m.showAlerts && (
              <AlertsDigest
                onClose={() => m.setShowAlerts(false)}
                onPrefill={(text) => {
                  m.setMessage(text);
                  m.inputRef.current?.focus();
                }}
              />
            )}

            <ChatMessageList
              history={m.history}
              isPending={m.sendMutation.isPending}
              displaySuggestions={displaySuggestions}
              handleSuggestionClick={(s) => m.handleSend(s)}
              formatMsgTime={formatMsgTime}
              feedbackGiven={m.feedbackGiven}
              handleFeedback={m.handleFeedback}
              lastUsedProvider={m.lastUsedProvider}
              pendingVoucher={m.pendingVoucher}
              handleConfirmVoucher={m.handleConfirmVoucher}
              setPendingVoucher={m.setPendingVoucher}
              voucherSubmitting={m.voucherSubmitting}
              pendingStockTransfer={m.pendingStockTransfer}
              handleConfirmStockTransfer={m.handleConfirmStockTransfer}
              setPendingStockTransfer={m.setPendingStockTransfer}
              stockTransferSubmitting={m.stockTransferSubmitting}
              pendingStockTransferBatch={m.pendingStockTransferBatch}
              handleConfirmStockTransferBatchItem={m.handleConfirmStockTransferBatchItem}
              handleDismissStockTransferBatchItem={m.handleDismissStockTransferBatchItem}
              pendingStockAdj={m.pendingStockAdj}
              handleConfirmStockAdj={m.handleConfirmStockAdj}
              setPendingStockAdj={m.setPendingStockAdj}
              stockAdjSubmitting={m.stockAdjSubmitting}
              voucherSearchResults={m.voucherSearchResults}
              setVoucherSearchResults={m.setVoucherSearchResults}
              pendingStockItem={m.pendingStockItem}
              handleConfirmStockItem={m.handleConfirmStockItem}
              setPendingStockItem={m.setPendingStockItem}
              stockItemSubmitting={m.stockItemSubmitting}
              pendingPriceUpdate={m.pendingPriceUpdate}
              handleConfirmPriceUpdate={m.handleConfirmPriceUpdate}
              setPendingPriceUpdate={m.setPendingPriceUpdate}
              priceUpdateSubmitting={m.priceUpdateSubmitting}
              accountQueryResult={m.accountQueryResult}
              setAccountQueryResult={m.setAccountQueryResult}
              poDraft={m.poDraft}
              handleConfirmPOImport={m.handleConfirmPOImport}
              setPoDraft={m.setPoDraft}
              poDraftSubmitting={m.poDraftSubmitting}
              poDraftResult={m.poDraftResult}
              poDraftError={m.poDraftError}
              setPoDraftResult={m.setPoDraftResult}
              setPoDraftError={m.setPoDraftError}
              verifyContainerDraft={m.verifyContainerDraft}
              setVerifyContainerDraft={m.setVerifyContainerDraft}
              dataQueryResult={m.dataQueryResult}
              setDataQueryResult={m.setDataQueryResult}
              pendingFilePatches={m.pendingFilePatches}
              setPendingFilePatches={m.setPendingFilePatches}
              appliedPatchFiles={m.appliedPatchFiles}
              setAppliedPatchFiles={m.setAppliedPatchFiles}
              patchApplying={m.patchApplying}
              handleApplyPatch={m.handleApplyPatch}
              handleApplyAllPatches={m.handleApplyAllPatches}
              handleGitPush={m.handleGitPush}
              gitPushing={m.gitPushing}
              perFilePushResult={m.perFilePushResult}
              setPerFilePushResult={m.setPerFilePushResult}
              scrollAreaRef={m.scrollAreaRef}
            />

            {m.sessionReadFiles.length > 0 && (
              <div className="px-4 pb-1 border-b border-border/40">
                <button
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors mb-1"
                  onClick={() => m.setShowSessionFiles((v) => !v)}
                >
                  {m.showSessionFiles ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  <FileCode className="h-3 w-3" />
                  {m.sessionReadFiles.length} file{m.sessionReadFiles.length !== 1 ? "s" : ""} read this session
                </button>
                {m.showSessionFiles && (
                  <div className="flex flex-wrap gap-1 pb-1">
                    {m.sessionReadFiles.map((fp) => (
                      <span
                        key={fp}
                        className="inline-flex items-center gap-1 text-[11px] font-mono bg-muted rounded-sm px-1.5 py-0.5 text-muted-foreground"
                      >
                        <FileCode className="h-2.5 w-2.5 shrink-0" />
                        {fp.replace(/^.*\//, "")}
                      </span>
                    ))}
                    <button
                      className="text-[11px] text-muted-foreground/60 hover:text-muted-foreground transition-colors px-1"
                      onClick={() => {
                        m.setSessionReadFiles([]);
                        m.setShowSessionFiles(false);
                      }}
                    >
                      clear
                    </button>
                  </div>
                )}
              </div>
            )}

            <ChatWidgetInput
              fileInputRef={m.fileInputRef}
              handleFileSelect={m.handleFileSelect}
              poDraftUploading={m.poDraftUploading}
              isPending={m.sendMutation.isPending}
              inputRef={m.inputRef}
              message={m.message}
              setMessage={m.setMessage}
              handleKeyDown={m.handleKeyDown}
              handleSend={m.handleSend}
              isError={m.sendMutation.isError}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
