import { Bot, Sparkles, ThumbsUp, ThumbsDown, Cpu, Loader2, Check } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ChatMessage,
  VoucherDraft,
  StockTransferDraft,
  StockAdjustmentDraft,
  VoucherSearchResult,
  StockItemDraft,
  PriceUpdateDraft,
  AccountQueryResult,
  POImportDraft,
  POImportResult,
  VerifyContainerDraft,
  DataQueryResult,
  FilePatchDraft,
  PushResult,
} from "./chatWidgetTypes";
import { CodeBlock, PROVIDER_LABELS } from "./FileDiffCard";
import { VoucherConfirmCard, AccountQueryResultCard } from "./AccountVoucherCards";
import { StockTransferConfirmCard, VerifyContainerCard, DataQueryResultCard } from "./TransferContainerCards";
import {
  StockAdjustmentConfirmCard,
  VoucherSearchResultsCard,
  StockItemConfirmCard,
  PriceUpdateConfirmCard,
} from "./ConfirmCards";
import { POImportDraftCard } from "./POImportDraftCard";
import { FileDiffCard } from "./FileDiffCard";

interface ChatMessageListProps {
  history: ChatMessage[];
  isPending: boolean;
  displaySuggestions: string[];
  handleSuggestionClick: (suggestion: string) => void;
  formatMsgTime: (iso: string) => string;
  feedbackGiven: Record<number, "positive" | "negative">;
  handleFeedback: (messageId: number, type: "positive" | "negative") => void;
  lastUsedProvider: string | null;
  pendingVoucher: VoucherDraft | null;
  handleConfirmVoucher: (edited: VoucherDraft) => void;
  setPendingVoucher: (v: VoucherDraft | null) => void;
  voucherSubmitting: boolean;
  pendingStockTransfer: StockTransferDraft | null;
  handleConfirmStockTransfer: (resolved: StockTransferDraft) => void;
  setPendingStockTransfer: (v: StockTransferDraft | null) => void;
  stockTransferSubmitting: boolean;
  pendingStockTransferBatch: StockTransferDraft[] | null;
  handleConfirmStockTransferBatchItem: (index: number, resolved: StockTransferDraft) => void;
  handleDismissStockTransferBatchItem: (index: number) => void;
  pendingStockAdj: StockAdjustmentDraft | null;
  handleConfirmStockAdj: (resolved: StockAdjustmentDraft) => void;
  setPendingStockAdj: (v: StockAdjustmentDraft | null) => void;
  stockAdjSubmitting: boolean;
  voucherSearchResults: VoucherSearchResult[] | null;
  setVoucherSearchResults: (v: VoucherSearchResult[] | null) => void;
  pendingStockItem: StockItemDraft | null;
  handleConfirmStockItem: (resolved: StockItemDraft) => void;
  setPendingStockItem: (v: StockItemDraft | null) => void;
  stockItemSubmitting: boolean;
  pendingPriceUpdate: PriceUpdateDraft | null;
  handleConfirmPriceUpdate: (resolved: PriceUpdateDraft) => void;
  setPendingPriceUpdate: (v: PriceUpdateDraft | null) => void;
  priceUpdateSubmitting: boolean;
  accountQueryResult: AccountQueryResult | null;
  setAccountQueryResult: (v: AccountQueryResult | null) => void;
  poDraft: POImportDraft | null;
  handleConfirmPOImport: (resolved: unknown) => void;
  setPoDraft: (v: POImportDraft | null) => void;
  poDraftSubmitting: boolean;
  poDraftResult: POImportResult | null;
  poDraftError: string | null;
  setPoDraftResult: (v: POImportResult | null) => void;
  setPoDraftError: (v: string | null) => void;
  verifyContainerDraft: VerifyContainerDraft | null;
  setVerifyContainerDraft: (v: VerifyContainerDraft | null) => void;
  dataQueryResult: DataQueryResult | null;
  setDataQueryResult: (v: DataQueryResult | null) => void;
  pendingFilePatches: FilePatchDraft[];
  setPendingFilePatches: (v: FilePatchDraft[]) => void;
  appliedPatchFiles: Set<string>;
  setAppliedPatchFiles: (v: Set<string>) => void;
  patchApplying: string | null;
  handleApplyPatch: (patch: FilePatchDraft) => void;
  handleApplyAllPatches: () => void;
  handleGitPush: (filePath: string, commitMsg: string) => void;
  gitPushing: boolean;
  perFilePushResult: Record<string, PushResult>;
  setPerFilePushResult: (v: Record<string, PushResult>) => void;
  scrollAreaRef: React.RefObject<HTMLDivElement | null>;
}

export function ChatMessageList({
  history,
  isPending,
  displaySuggestions,
  handleSuggestionClick,
  formatMsgTime,
  feedbackGiven,
  handleFeedback,
  lastUsedProvider,
  pendingVoucher,
  handleConfirmVoucher,
  setPendingVoucher,
  voucherSubmitting,
  pendingStockTransfer,
  handleConfirmStockTransfer,
  setPendingStockTransfer,
  stockTransferSubmitting,
  pendingStockTransferBatch,
  handleConfirmStockTransferBatchItem,
  handleDismissStockTransferBatchItem,
  pendingStockAdj,
  handleConfirmStockAdj,
  setPendingStockAdj,
  stockAdjSubmitting,
  voucherSearchResults,
  setVoucherSearchResults,
  pendingStockItem,
  handleConfirmStockItem,
  setPendingStockItem,
  stockItemSubmitting,
  pendingPriceUpdate,
  handleConfirmPriceUpdate,
  setPendingPriceUpdate,
  priceUpdateSubmitting,
  accountQueryResult,
  setAccountQueryResult,
  poDraft,
  handleConfirmPOImport,
  setPoDraft,
  poDraftSubmitting,
  poDraftResult,
  poDraftError,
  setPoDraftResult,
  setPoDraftError,
  verifyContainerDraft,
  setVerifyContainerDraft,
  dataQueryResult,
  setDataQueryResult,
  pendingFilePatches,
  setPendingFilePatches,
  appliedPatchFiles,
  setAppliedPatchFiles,
  patchApplying,
  handleApplyPatch,
  handleApplyAllPatches,
  handleGitPush,
  gitPushing,
  perFilePushResult,
  setPerFilePushResult,
  scrollAreaRef,
}: ChatMessageListProps) {
  return (
    <ScrollArea ref={scrollAreaRef as React.RefObject<HTMLDivElement>} className="flex-1 px-4 py-3">
      {history.length === 0 && !isPending && (
        <div className="flex flex-col items-center justify-center h-full text-center py-6">
          <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Bot className="h-8 w-8 text-primary" />
          </div>
          <h3 className="font-semibold text-lg mb-1">Hello! I'm your AI Assistant</h3>
          <p className="text-sm text-muted-foreground mb-4 max-w-[280px]">
            Ask me anything — ERP data, code, general questions, or have me build you a mini app.
          </p>

          {displaySuggestions.length > 0 && (
            <div className="w-full space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Try asking:</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {displaySuggestions.map((suggestion, index) => (
                  <Badge
                    key={index}
                    variant="outline"
                    className="cursor-pointer hover-elevate text-xs py-1.5 px-3"
                    onClick={() => handleSuggestionClick(suggestion)}
                    data-testid={`suggestion-chip-${index}`}
                  >
                    {suggestion}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-5">
        {history.map((msg) => (
          <div
            key={msg.id}
            className={cn("flex gap-2.5", msg.role === "user" ? "justify-end" : "justify-start")}
            data-testid={`chat-message-${msg.id}`}
          >
            {msg.role === "assistant" && (
              <div className="shrink-0 h-7 w-7 rounded-full bg-blue-500 dark:bg-blue-600 flex items-center justify-center mt-1">
                <Sparkles className="h-3.5 w-3.5 text-white" />
              </div>
            )}
            <div className="flex flex-col max-w-[83%]">
              <div className={cn("flex items-center gap-1.5 mb-1 px-0.5", msg.role === "user" ? "justify-end" : "")}>
                <span className="text-[11px] text-muted-foreground">
                  {msg.role === "assistant" ? "Assistant" : "You"}
                  {msg.createdAt ? ` · ${formatMsgTime(msg.createdAt)}` : ""}
                </span>
              </div>
              <div
                className={cn(
                  "px-4 py-2.5 text-sm leading-relaxed",
                  msg.role === "user"
                    ? "bg-blue-50 text-blue-900 dark:bg-blue-900/50 dark:text-blue-100 rounded-2xl rounded-tr-sm"
                    : "bg-gray-50 dark:bg-zinc-800/80 rounded-2xl rounded-tl-sm"
                )}
              >
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none wrap-break-word [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        table: ({ children }) => (
                          <div className="overflow-x-auto my-2">
                            <table className="min-w-full text-xs border-collapse">{children}</table>
                          </div>
                        ),
                        th: ({ children }) => (
                          <th className="border border-border px-2 py-1 bg-muted font-medium text-left">{children}</th>
                        ),
                        td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>,
                        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
                        ul: ({ children }) => <ul className="list-disc pl-4 mb-2 space-y-1">{children}</ul>,
                        ol: ({ children }) => <ol className="list-decimal pl-4 mb-2 space-y-1">{children}</ol>,
                        li: ({ children }) => <li className="text-sm">{children}</li>,
                        code: ({ children, className }) => {
                          const isInline = !className;
                          if (isInline) {
                            return (
                              <code className="bg-muted px-1 py-0.5 rounded-sm text-xs font-mono">{children}</code>
                            );
                          }
                          const lang = (className ?? "").replace("language-", "");
                          const codeStr = Array.isArray(children) ? children.join("") : String(children ?? "");
                          return <CodeBlock code={codeStr.replace(/\n$/, "")} lang={lang} />;
                        },
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                      }}
                    >
                      {msg.message}
                    </ReactMarkdown>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap wrap-break-word">{msg.message}</p>
                )}
              </div>

              {msg.role === "assistant" && (
                <div className="flex items-center gap-1 mt-1 ml-1 flex-wrap">
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("h-6 w-6", feedbackGiven[msg.id] === "positive" && "text-green-500")}
                    onClick={() => handleFeedback(msg.id, "positive")}
                    disabled={!!feedbackGiven[msg.id]}
                    data-testid={`feedback-positive-${msg.id}`}
                  >
                    <ThumbsUp className="h-3 w-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className={cn("h-6 w-6", feedbackGiven[msg.id] === "negative" && "text-red-500")}
                    onClick={() => handleFeedback(msg.id, "negative")}
                    disabled={!!feedbackGiven[msg.id]}
                    data-testid={`feedback-negative-${msg.id}`}
                  >
                    <ThumbsDown className="h-3 w-3" />
                  </Button>
                  {lastUsedProvider && history[history.length - 1]?.id === msg.id && (
                    <span
                      className="flex items-center gap-1 text-[10px] text-muted-foreground/70 ml-1"
                      data-testid={`provider-badge-${msg.id}`}
                    >
                      <Cpu className="h-2.5 w-2.5" />
                      {PROVIDER_LABELS[lastUsedProvider] ?? lastUsedProvider}
                    </span>
                  )}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="shrink-0 h-7 w-7 rounded-full bg-gray-200 dark:bg-zinc-700 flex items-center justify-center mt-1 text-xs font-semibold text-gray-600 dark:text-zinc-300">
                U
              </div>
            )}
          </div>
        ))}

        {isPending && (
          <div className="flex gap-2.5 justify-start">
            <div className="shrink-0 h-7 w-7 rounded-full bg-blue-500 dark:bg-blue-600 flex items-center justify-center">
              <Sparkles className="h-3.5 w-3.5 text-white" />
            </div>
            <div className="bg-gray-50 dark:bg-zinc-800/80 rounded-2xl rounded-tl-sm px-4 py-2.5">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Thinking...</span>
              </div>
            </div>
          </div>
        )}

        {pendingVoucher && !isPending && (
          <VoucherConfirmCard
            draft={pendingVoucher}
            onConfirm={handleConfirmVoucher}
            onDismiss={() => setPendingVoucher(null)}
            isSubmitting={voucherSubmitting}
          />
        )}

        {pendingStockTransfer && !isPending && (
          <StockTransferConfirmCard
            draft={pendingStockTransfer}
            onConfirm={handleConfirmStockTransfer}
            onDismiss={() => setPendingStockTransfer(null)}
            isSubmitting={stockTransferSubmitting}
          />
        )}

        {pendingStockTransferBatch && pendingStockTransferBatch.length > 0 && !isPending && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground px-1">
              {pendingStockTransferBatch.length} pending transfer draft{pendingStockTransferBatch.length > 1 ? "s" : ""}{" "}
              — review each below.
            </p>
            {pendingStockTransferBatch.map((draft, idx) => (
              <StockTransferConfirmCard
                key={`${draft.sourceLocationId}-${draft.destinationLocationId}-${idx}`}
                draft={draft}
                onConfirm={(resolved) => handleConfirmStockTransferBatchItem(idx, resolved)}
                onDismiss={() => handleDismissStockTransferBatchItem(idx)}
                isSubmitting={stockTransferSubmitting}
              />
            ))}
          </div>
        )}

        {pendingStockAdj && !isPending && (
          <StockAdjustmentConfirmCard
            draft={pendingStockAdj}
            onConfirm={handleConfirmStockAdj}
            onDismiss={() => setPendingStockAdj(null)}
            isSubmitting={stockAdjSubmitting}
          />
        )}

        {voucherSearchResults && voucherSearchResults.length > 0 && !isPending && (
          <VoucherSearchResultsCard results={voucherSearchResults} onDismiss={() => setVoucherSearchResults(null)} />
        )}

        {pendingStockItem && !isPending && (
          <StockItemConfirmCard
            draft={pendingStockItem}
            onConfirm={handleConfirmStockItem}
            onDismiss={() => setPendingStockItem(null)}
            isSubmitting={stockItemSubmitting}
          />
        )}

        {pendingPriceUpdate && !isPending && (
          <PriceUpdateConfirmCard
            draft={pendingPriceUpdate}
            onConfirm={handleConfirmPriceUpdate}
            onDismiss={() => setPendingPriceUpdate(null)}
            isSubmitting={priceUpdateSubmitting}
          />
        )}

        {accountQueryResult && !isPending && (
          <AccountQueryResultCard result={accountQueryResult} onDismiss={() => setAccountQueryResult(null)} />
        )}

        {poDraft && (
          <POImportDraftCard
            draft={poDraft}
            onConfirm={handleConfirmPOImport}
            onDismiss={() => {
              setPoDraft(null);
              setPoDraftResult(null);
              setPoDraftError(null);
              setVerifyContainerDraft(null);
            }}
            isSubmitting={poDraftSubmitting}
            result={poDraftResult}
            importError={poDraftError}
          />
        )}

        {verifyContainerDraft && !isPending && (
          <VerifyContainerCard draft={verifyContainerDraft} onDismiss={() => setVerifyContainerDraft(null)} />
        )}

        {dataQueryResult && !isPending && (
          <DataQueryResultCard result={dataQueryResult} onDismiss={() => setDataQueryResult(null)} />
        )}

        {pendingFilePatches.length > 0 && !isPending && (
          <div className="mt-3 space-y-3">
            {pendingFilePatches.length > 1 && (
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-xs text-muted-foreground font-medium">
                  {pendingFilePatches.length} files to change
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setPendingFilePatches([]);
                      setAppliedPatchFiles(new Set());
                      setPerFilePushResult({});
                    }}
                  >
                    Cancel All
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleApplyAllPatches}
                    disabled={
                      patchApplying !== null || pendingFilePatches.every((p) => appliedPatchFiles.has(p.filePath))
                    }
                  >
                    {patchApplying !== null ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <Check className="h-3 w-3 mr-1" />
                    )}
                    Apply All
                  </Button>
                </div>
              </div>
            )}
            {pendingFilePatches.map((draft) => (
              <FileDiffCard
                key={draft.filePath}
                draft={draft}
                onApply={handleApplyPatch}
                onCancel={(fp: string) =>
                  setPendingFilePatches(pendingFilePatches.filter((p: FilePatchDraft) => p.filePath !== fp))
                }
                isApplying={patchApplying === draft.filePath}
                isApplied={appliedPatchFiles.has(draft.filePath)}
                onGitPush={handleGitPush}
                isPushing={gitPushing}
                pushResult={perFilePushResult[draft.filePath] ?? null}
              />
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
