import { useState } from "react";
import { EyeOff, Eye, Check, Copy, FileCode, Plus, Minus } from "lucide-react";
import { cn } from "@/lib/utils";
import { FilePatchDraft } from "./chatWidgetTypes";

// Built by concatenation so the literal `</script>` never appears contiguously
// in the bundle. Written inline it would end the enclosing script block early
// wherever this bundle is inlined into a document; written as `<\/script>` it
// is the same string but reads to ESLint as a pointless escape.
const SCRIPT_CLOSE = ["</", "scr", "ipt>"].join("");

// ── Provider display helpers ─────────────────────────────────────────
export const PROVIDER_LABELS: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
};

// ── Inline Code Block with copy + live preview ───────────────────────
export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const normalizedLang = lang.toLowerCase().trim();
  const isPreviewable = ["html", "htm", "javascript", "js"].includes(normalizedLang);

  const handleCopy = () => {
    navigator.clipboard.writeText(code).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getPreviewSrcdoc = () => {
    if (normalizedLang === "javascript" || normalizedLang === "js") {
      return `<!DOCTYPE html><html><body><script>\n${code}\n${SCRIPT_CLOSE}</body></html>`;
    }
    return code;
  };

  return (
    <div className="my-2 rounded-md border border-border overflow-hidden text-left">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/60 border-b border-border gap-2">
        <span className="text-xs font-mono text-muted-foreground">{normalizedLang || "code"}</span>
        <div className="flex items-center gap-1">
          {isPreviewable && (
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded-sm hover:bg-muted"
              onClick={() => setShowPreview((v) => !v)}
              type="button"
            >
              {showPreview ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {showPreview ? "Hide" : "Preview"}
            </button>
          )}
          <button
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-0.5 rounded-sm hover:bg-muted"
            onClick={handleCopy}
            type="button"
          >
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="overflow-x-auto p-3 text-xs font-mono bg-zinc-950 dark:bg-zinc-900 text-zinc-100 leading-relaxed m-0">
        <code>{code}</code>
      </pre>
      {showPreview && isPreviewable && (
        <div className="border-t border-border">
          <div className="px-3 py-1.5 bg-muted/40 text-xs text-muted-foreground flex items-center gap-1.5">
            <Eye className="h-3 w-3" />
            Live Preview
          </div>
          <iframe
            srcDoc={getPreviewSrcdoc()}
            className="w-full bg-white"
            style={{ height: "280px", border: "none" }}
            sandbox="allow-scripts allow-same-origin"
            title="Code preview"
          />
        </div>
      )}
    </div>
  );
}

// ── File diff helpers ─────────────────────────────────────────────────────
type DiffLine = { type: "same" | "add" | "remove"; line: string };

export function computeLineDiff(original: string, modified: string): DiffLine[] {
  const oldLines = original.split("\n");
  const newLines = modified.split("\n");
  const MAX = 400;
  if (oldLines.length > MAX || newLines.length > MAX) {
    return newLines.map((line) => ({ type: "add" as const, line }));
  }
  const m = oldLines.length,
    n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: "same", line: oldLines[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: "add", line: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: "remove", line: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

export interface PushResult {
  success: boolean;
  commitHash?: string;
  branch?: string;
  error?: string;
}

export interface FileDiffCardProps {
  draft: FilePatchDraft;
  onApply: (patch: FilePatchDraft) => void;
  onCancel: (filePath: string) => void;
  isApplying: boolean;
  isApplied: boolean;
  onGitPush: (filePath: string, commitMsg: string) => void;
  isPushing: boolean;
  pushResult: PushResult | null;
}

export function FileDiffCard({
  draft,
  onApply: _onApply,
  onCancel: _onCancel,
  isApplying: _isApplying,
  isApplied: _isApplied,
  onGitPush: _onGitPush,
  isPushing: _isPushing,
  pushResult: _pushResult,
}: FileDiffCardProps) {
  const [showFullDiff, setShowFullDiff] = useState(false);

  const diffLines = computeLineDiff(draft.originalContent, draft.newContent);
  const CONTEXT = 3;
  const visibleSet = new Set<number>();
  diffLines.forEach((dl, idx) => {
    if (dl.type !== "same") {
      for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(diffLines.length - 1, idx + CONTEXT); k++) {
        visibleSet.add(k);
      }
    }
  });

  const added = diffLines.filter((l) => l.type === "add").length;
  const removed = diffLines.filter((l) => l.type === "remove").length;
  const hasChanges = added > 0 || removed > 0;

  type Segment = { isSkip: true; count: number } | { isSkip: false; item: DiffLine & { idx: number } };
  const segments: Segment[] = [];
  let prevIdx = -1;
  diffLines.forEach((dl, idx) => {
    if (!visibleSet.has(idx)) return;
    if (prevIdx !== -1 && idx > prevIdx + 1) {
      segments.push({ isSkip: true, count: idx - prevIdx - 1 });
    }
    segments.push({ isSkip: false, item: { ...dl, idx } });
    prevIdx = idx;
  });
  if (diffLines.length > 0 && prevIdx < diffLines.length - 1 && visibleSet.size > 0) {
    const trailingSkip = diffLines.length - 1 - prevIdx;
    if (trailingSkip > 0) segments.push({ isSkip: true, count: trailingSkip });
  }

  return (
    <div className="rounded-md border border-border bg-background mt-3 overflow-hidden text-left">
      <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-xs font-mono text-foreground truncate max-w-[220px]">{draft.filePath}</span>
        </div>
        <div className="flex items-center gap-2 text-xs shrink-0">
          {added > 0 && (
            <span className="text-green-600 dark:text-green-400 flex items-center gap-0.5">
              <Plus className="h-3 w-3" />
              {added}
            </span>
          )}
          {removed > 0 && (
            <span className="text-red-500 dark:text-red-400 flex items-center gap-0.5">
              <Minus className="h-3 w-3" />
              {removed}
            </span>
          )}
        </div>
      </div>

      <div className="px-3 py-2 bg-muted/20 border-b border-border">
        <p className="text-xs text-muted-foreground leading-relaxed">{draft.description}</p>
      </div>

      {hasChanges ? (
        <div className="overflow-hidden">
          <pre
            className={cn(
              "overflow-x-auto text-xs font-mono leading-5 overflow-y-auto transition-all",
              showFullDiff ? "max-h-[480px]" : "max-h-64"
            )}
          >
            {segments.length === 0
              ? diffLines.map((dl, idx) => (
                  <div
                    key={idx}
                    className={cn(
                      "px-3 py-px whitespace-pre",
                      dl.type === "add" && "bg-green-950/40 dark:bg-green-900/30 text-green-300",
                      dl.type === "remove" && "bg-red-950/40 dark:bg-red-900/30 text-red-300",
                      dl.type === "same" && "text-muted-foreground"
                    )}
                  >
                    <span className="select-none opacity-50 mr-2 w-3 inline-block">
                      {dl.type === "add" ? "+" : dl.type === "remove" ? "-" : " "}
                    </span>
                    {dl.line}
                  </div>
                ))
              : segments.map((seg, si) =>
                  seg.isSkip ? (
                    <div
                      key={`skip-${si}`}
                      className="px-3 py-0.5 text-muted-foreground/50 bg-muted/20 text-xs select-none"
                    >
                      ... {seg.count} unchanged {seg.count === 1 ? "line" : "lines"} ...
                    </div>
                  ) : (
                    <div
                      key={seg.item.idx}
                      className={cn(
                        "px-3 py-px whitespace-pre",
                        seg.item.type === "add" && "bg-green-950/40 dark:bg-green-900/30 text-green-300",
                        seg.item.type === "remove" && "bg-red-950/40 dark:bg-red-900/30 text-red-300",
                        seg.item.type === "same" && "text-muted-foreground"
                      )}
                    >
                      <span className="select-none opacity-50 mr-2 w-3 inline-block">
                        {seg.item.type === "add" ? "+" : seg.item.type === "remove" ? "-" : " "}
                      </span>
                      {seg.item.line}
                    </div>
                  )
                )}
          </pre>
          {diffLines.length > 20 && (
            <button
              type="button"
              className="w-full text-xs text-muted-foreground py-1 bg-muted/20 border-t border-border hover:bg-muted/40 transition-colors"
              onClick={() => setShowFullDiff((v) => !v)}
            >
              {showFullDiff ? "Collapse diff" : `Show full diff (${diffLines.length} lines)`}
            </button>
          )}
        </div>
      ) : (
        <div className="px-3 py-3 text-xs text-muted-foreground">No changes detected.</div>
      )}
    </div>
  );
}
