import { useState, useEffect, useRef } from "react";
import { StickyNote } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { OTW_NOTES_KEY, otwFmtCcy, otwCcySymbol, getContainerStatusLabel } from "./otwHelpers";

export function OtwCurrencyInline({ amounts }: { amounts: Record<string, number> }) {
  const entries = Object.entries(amounts).filter(([, v]) => v > 0);
  if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-col items-end gap-0.5">
      {entries.map(([ccy, amt]) => (
        <span key={ccy} className="font-mono text-base font-semibold whitespace-nowrap">
          {otwFmtCcy(otwCcySymbol(ccy), amt)}
        </span>
      ))}
    </span>
  );
}

export function OtwNotes() {
  const [value, setValue] = useState(() => localStorage.getItem(OTW_NOTES_KEY) ?? "");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      localStorage.setItem(OTW_NOTES_KEY, e.target.value);
    }, 600);
  }

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card/90 shadow-sm dark:border-blue-200/10 dark:bg-slate-900/55" aria-label="Container notes">
      <div className="flex items-center gap-3 border-b border-border/60 bg-gradient-to-r from-blue-500/5 to-transparent px-4 py-3 sm:px-5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300">
          <StickyNote className="h-4 w-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">Notes</span>
        <span className="ml-auto text-xs text-muted-foreground">Auto-saved</span>
      </div>
      <div className="p-3 sm:p-4">
        <Textarea
          value={value}
          onChange={handleChange}
          placeholder="Write anything here…"
          aria-label="Container notes"
          className="min-h-[96px] resize-y rounded-xl border border-border/60 bg-muted/20 px-4 py-3 text-sm shadow-inner focus-visible:border-blue-500/40 focus-visible:ring-2 focus-visible:ring-blue-500/20 dark:bg-slate-950/40"
          data-testid="textarea-otw-notes"
        />
      </div>
    </section>
  );
}

export function ContainerStatusBadge({ status }: { status: string }) {
  const label = getContainerStatusLabel(status);
  if (status === "OFFLOADED") {
    return (
      <Badge className="text-xs bg-green-500/10 text-green-700 dark:text-green-300 border-green-500/20">{label}</Badge>
    );
  }
  if (status === "PARTIALLY_RECEIVED") {
    return (
      <Badge className="text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20">{label}</Badge>
    );
  }
  if (status === "IN_TRANSIT") {
    return (
      <Badge className="text-xs bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/20">{label}</Badge>
    );
  }
  if (status === "ARRIVED") {
    return (
      <Badge className="text-xs bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20">
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      {label}
    </Badge>
  );
}
