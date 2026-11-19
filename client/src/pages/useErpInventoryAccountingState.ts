// Extracted from ./ErpInventoryAccounting.tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { get, type Kind, type Status, type Audit, type Readiness } from "./ErpInventoryAccountingHelpers";

export function useErpInventoryAccountingState() {
  const [asOf, setAsOf] = useState("");
  const [kind, setKind] = useState<Kind | "all">("all");
  const [status, setStatus] = useState<Status | "all">("all");
  const audit = useQuery<Audit>({
    queryKey: ["/api/accounting/erp-inventory/audit", asOf],
    queryFn: () => get("/api/accounting/erp-inventory/audit" + (asOf ? "?asOfDate=" + asOf : "")),
    retry: false,
  });
  const readiness = useQuery<Readiness>({
    queryKey: ["/api/accounting/erp-inventory/readiness"],
    queryFn: () => get("/api/accounting/erp-inventory/readiness"),
    retry: false,
  });
  const current = audit.data;
  const rows = useMemo(
    () =>
      current?.journals.filter(
        (r) => (kind === "all" || r.kind === kind) && (status === "all" || r.status === status)
      ) ?? [],
    [current, kind, status]
  );
  return { asOf, setAsOf, kind, setKind, status, setStatus, audit, readiness, current, rows };
}
