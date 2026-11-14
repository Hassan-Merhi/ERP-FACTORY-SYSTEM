import { lazy, Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";

const LinkedTradesEditor = lazy(() =>
  import("../intercompany/LinkedTradesEditor").then((module) => ({ default: module.LinkedTradesEditorContent }))
);

type LinkedTrade = {
  tradeId: number;
  physicalContainerId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  containerNumber: string;
};

/**
 * An imported container is one physical asset with source and destination POs.
 * Destination editors must use the synchronized trade revision workflow rather
 * than editing their PO in isolation and drifting from the parent company.
 */
export default function LinkedDestinationContainerEditor({ containerId }: { containerId: number }) {
  const { selectedCompany } = useCompany();
  const companyId = selectedCompany?.id ?? 0;
  const role = selectedCompany?.role ?? "";
  const eligible = companyId > 0 && ["Owner", "Admin", "Developer"].includes(role);
  const url = "/api/intercompany-container-trading/linked-trades";
  const { data, isError } = useQuery<{ trades: LinkedTrade[] }>({
    queryKey: companyQueryKey(url, companyId, containerId),
    enabled: eligible && containerId > 0,
    queryFn: async () => {
      const result = await fetch(url + "?physicalContainerId=" + containerId, { credentials: "include" });
      if (!result.ok) throw new Error("Unable to load linked intercompany PO");
      return result.json();
    },
  });

  if (!eligible || isError) return null;
  const trade = data?.trades.find(
    (row) => row.physicalContainerId === containerId && row.destinationCompanyId === companyId
  );
  if (!trade) return null;

  return (
    <section aria-label="Linked parent company purchase order" className="space-y-3">
      <p className="text-sm text-muted-foreground">
        This is the same physical container as in the parent company. Tracking updates are shared, and PO cost or line
        revisions must use the synchronized editor below.
      </p>
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading linked PO editor...</p>}>
        <LinkedTradesEditor physicalContainerId={containerId} embedded />
      </Suspense>
    </section>
  );
}
