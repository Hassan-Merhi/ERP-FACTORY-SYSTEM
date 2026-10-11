import { Badge } from "@/components/ui/badge";

export function badgePct(pct: number | null | undefined) {
  const value = pct ?? 0;
  return (
    <Badge
      variant="outline"
      className={
        value > 0
          ? "text-red-500 border-red-500/30 bg-red-500/10"
          : "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
      }
    >
      {value > 0 ? "+" : ""}
      {value.toFixed(2)}%
    </Badge>
  );
}

export function statusBadge(status: string) {
  const className =
    status === "CLOSED" || status === "COMPLETED"
      ? "text-amber-600 border-amber-500/30 bg-amber-500/10"
      : "text-muted-foreground";
  return (
    <Badge variant="outline" className={className}>
      {status}
    </Badge>
  );
}

export function codeBadge(code: string) {
  const className =
    code === "CORRECT"
      ? "text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
      : code === "UNRESOLVED_FX" || code === "MANUAL_REVIEW_REQUIRED"
        ? "text-amber-600 border-amber-500/30 bg-amber-500/10"
        : "text-red-500 border-red-500/30 bg-red-500/10";
  return (
    <Badge key={code} variant="outline" className={`${className} text-[11px] mr-1`}>
      {code}
    </Badge>
  );
}
