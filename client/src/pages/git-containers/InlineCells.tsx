import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { CheckCircle2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtDate, parseNum, fmt, TRANSPORTER_OPTIONS, EnrichedContainerRow } from "./gitContainerTypes";
import { gitTrackingPatchUrl } from "./gitTrackingPatchUrl";
import { invalidateApiFamily } from "@/lib/frontendDataArchitecture";

// Shared mutation hook — invalidates the full containers list on success
export function useInlinePatch(containerId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      apiRequest("PATCH", gitTrackingPatchUrl(containerId), patch),
    onSuccess: () => invalidateApiFamily(qc, "/api/git/containers"),
  });
}

export function EtaCell({ container }: { container: EnrichedContainerRow }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(container.eta ?? "");

  const mutation = useMutation({
    mutationFn: (eta: string | null) =>
      apiRequest("PATCH", gitTrackingPatchUrl(container.id), { eta, etaSource: eta ? "manual" : undefined }),
    onSuccess: () => {
      invalidateApiFamily(queryClient, "/api/git/containers");
      setEditing(false);
    },
  });

  function save() {
    mutation.mutate(value || null);
  }

  if (editing) {
    return (
      <input
        type="date"
        value={value}
        autoFocus
        data-testid={`input-eta-inline-\${container.id}`}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setValue(container.eta ?? "");
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-[128px] h-8 rounded-md border border-input bg-background px-2 text-sm focus:outline-hidden focus:ring-1 focus:ring-ring"
      />
    );
  }

  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setValue(container.eta ?? "");
        setEditing(true);
      }}
      title="Click to set or edit ETA"
      data-testid={`text-eta-\${container.id}`}
      className="cursor-text underline decoration-dashed underline-offset-2 decoration-muted-foreground/40"
    >
      {container.eta ? (
        fmtDate(container.eta)
      ) : (
        <span className="text-muted-foreground/50 text-xs no-underline">set ETA</span>
      )}
    </span>
  );
}

export function InlineTextCell({
  id,
  field,
  value,
  mono,
  width,
  uppercase,
}: {
  id: number;
  field: string;
  value: string | null | undefined;
  mono?: boolean;
  width?: string;
  uppercase?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? "");
  const mutation = useInlinePatch(id);
  function save() {
    mutation.mutate({ [field]: val || null });
    setEditing(false);
  }
  if (editing)
    return (
      <input
        type="text"
        autoFocus
        value={val}
        onChange={(e) => setVal(uppercase ? e.target.value.toUpperCase() : e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setVal(value ?? "");
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: width ?? "110px" }}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
      />
    );
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setVal(value ?? "");
        setEditing(true);
      }}
      title="Click to edit"
      className={cn(
        "cursor-text underline decoration-dashed underline-offset-2 decoration-muted-foreground/40",
        mono && "font-mono"
      )}
    >
      {value ? uppercase ? value.toUpperCase() : value : <span className="text-muted-foreground/50 text-xs">—</span>}
    </span>
  );
}

export function InlineDateCell({ id, field, value }: { id: number; field: string; value: string | null | undefined }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? "");
  const mutation = useInlinePatch(id);
  function save() {
    mutation.mutate({ [field]: val || null });
    setEditing(false);
  }
  if (editing)
    return (
      <input
        type="date"
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setVal(value ?? "");
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className="w-[128px] h-7 rounded-md border border-input bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
      />
    );
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setVal(value ?? "");
        setEditing(true);
      }}
      title="Click to edit"
      className="cursor-text underline decoration-dashed underline-offset-2 decoration-muted-foreground/40"
    >
      {value ? fmtDate(value) : <span className="text-muted-foreground/50 text-xs">—</span>}
    </span>
  );
}

export function InlineNumberCell({
  id,
  field,
  value,
  prefix = "$",
  width,
}: {
  id: number;
  field: string;
  value: string | null | undefined;
  prefix?: string;
  width?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value ?? "");
  const mutation = useInlinePatch(id);
  function save() {
    mutation.mutate({ [field]: val || null });
    setEditing(false);
  }
  if (editing)
    return (
      <input
        type="number"
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") {
            setVal(value ?? "");
            setEditing(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
        style={{ width: width ?? "80px" }}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs text-right focus:outline-hidden focus:ring-1 focus:ring-ring"
      />
    );
  const num = parseNum(value);
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setVal(value ?? "");
        setEditing(true);
      }}
      title="Click to edit"
      className="cursor-text underline decoration-dashed underline-offset-2 decoration-muted-foreground/40"
    >
      {num > 0 ? `${prefix}${fmt(num)}` : <span className="text-muted-foreground/50 text-xs">—</span>}
    </span>
  );
}

export function InlineTransporterCell({ id, value }: { id: number; value: string | null | undefined }) {
  const [editing, setEditing] = useState(false);
  const mutation = useInlinePatch(id);
  function save(v: string) {
    mutation.mutate({ transporter: v || null });
    setEditing(false);
  }
  if (editing)
    return (
      <select
        autoFocus
        value={value ?? ""}
        onChange={(e) => save(e.target.value)}
        onBlur={() => setEditing(false)}
        onClick={(e) => e.stopPropagation()}
        className="h-7 rounded-md border border-input bg-background px-1.5 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
      >
        <option value="">—</option>
        {TRANSPORTER_OPTIONS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    );
  return (
    <span
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      title="Click to change transporter"
      className="cursor-pointer underline decoration-dashed underline-offset-2 decoration-muted-foreground/40"
    >
      {value || <span className="text-muted-foreground/50 text-xs">—</span>}
    </span>
  );
}

function getLocalDateYmd() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function InlineBoolCell({ id, field, value }: { id: number; field: string; value: boolean | null | undefined }) {
  const mutation = useInlinePatch(id);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        const nextValue = !value;
        const patch: Record<string, unknown> = { [field]: nextValue };

        // On the tracking table, the Docs checkmark records when the docs were sent.
        // Use the user's local calendar date so the saved day matches the day they clicked it.
        if (field === "docReceived") {
          patch.docsSentDate = nextValue ? getLocalDateYmd() : null;
        }

        mutation.mutate(patch);
      }}
      title={field === "docReceived" ? "Toggle docs and set Docs Sent date automatically" : "Click to toggle"}
      className="flex items-center justify-center"
    >
      {value ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <XCircle className="h-3.5 w-3.5 text-red-500" />
      )}
    </button>
  );
}

export function SummaryCard({
  label,
  value,
  icon,
  accent,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  accent?: string;
}) {
  const tone =
    label === "Delayed" || label === "Offload Overdue"
      ? "border-rose-200/70 from-rose-50 to-card dark:border-rose-500/30 dark:from-rose-500/15"
      : label === "Container Cost"
        ? "border-emerald-200/70 from-emerald-50 to-card dark:border-emerald-500/30 dark:from-emerald-500/15"
        : label === "Transport + Duty"
          ? "border-amber-200/70 from-amber-50 to-card dark:border-amber-500/30 dark:from-amber-500/15"
          : label === "At Sea / OTW" || label === "In Transit"
            ? "border-sky-200/70 from-sky-50 to-card dark:border-sky-500/30 dark:from-sky-500/15"
            : "border-violet-200/70 from-violet-50 to-card dark:border-violet-500/30 dark:from-violet-500/15";

  return (
    <div className={cn("flex min-w-0 items-center gap-3 rounded-xl border bg-gradient-to-br px-3 py-3 shadow-sm transition-colors dark:to-card sm:px-4 sm:py-4", tone)}>
      <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-lg", accent ?? "bg-muted")}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="mb-1 truncate text-xs font-medium text-muted-foreground">{label}</p>
        <p className="truncate text-lg font-bold leading-none tracking-tight tabular-nums sm:text-xl" title={String(value)}>{value}</p>
      </div>
    </div>
  );
}
