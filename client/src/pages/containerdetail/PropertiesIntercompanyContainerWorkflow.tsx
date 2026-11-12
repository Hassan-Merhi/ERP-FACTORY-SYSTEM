import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { propertiesContainerIntercompanyText } from "@/i18n/propertiesContainerIntercompanyTranslations";

const LinkedTradesEditor = lazy(() => import("../intercompany/LinkedTradesEditor"));
const IntercompanyLifecycle = lazy(() => import("../intercompany/IntercompanyLifecycle"));
const API = "/api/intercompany-container-trading/lifecycle";
type Trade = {
  tradeId: number;
  physicalContainerId: number;
  sourceCompanyId: number;
  destinationCompanyId: number;
  state: string;
  landedCost: string;
  received: null | { id: number; date: string };
  canceled: null | { id: number; date: string };
};

export default function PropertiesIntercompanyContainerWorkflow({ containerId }: { containerId: number }) {
  const { selectedCompany } = useCompany();
  const copy = propertiesContainerIntercompanyText(useApplicationLanguageCode());
  const companyId = selectedCompany?.id ?? 0;
  const role = selectedCompany?.role ?? "";
  const isProperties = selectedCompany?.companyType === "properties";
  const canRead = isProperties && ["Owner", "Developer", "Admin"].includes(role);
  const [tab, setTab] = useState("linked");
  const query = useQuery<{ trades: Trade[] }>({
    queryKey: companyQueryKey(API, companyId),
    enabled: canRead && Number.isSafeInteger(containerId) && containerId > 0,
    queryFn: async () => {
      const response = await fetch(API, { credentials: "include" });
      const data = await response.json().catch(() => ({ message: copy.failed }));
      if (!response.ok) throw new Error(data.message ?? copy.failed);
      return data as { trades: Trade[] };
    },
    retry: false,
  });
  const trade = query.data?.trades.find((candidate) =>
    candidate.physicalContainerId === containerId && candidate.sourceCompanyId === companyId
  );
  const closed = Boolean(trade && (trade.received || trade.canceled || trade.state !== "active"));

  useEffect(() => {
    setTab("linked");
  }, [companyId, containerId]);
  useEffect(() => {
    if (closed) setTab("lifecycle");
  }, [closed]);

  if (!isProperties) return null;
  const status = trade?.received ? copy.received : trade?.canceled ? copy.canceled : copy.active;
  return (
    <Card data-testid="properties-container-intercompany">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.subtitle}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!canRead && <p className="text-sm text-muted-foreground">{copy.unauthorized}</p>}
        {canRead && query.isLoading && <p className="text-sm text-muted-foreground">{copy.loading}</p>}
        {canRead && query.isError && (
          <p role="alert" className="text-sm text-destructive">{copy.failed}</p>
        )}
        {canRead && !query.isLoading && !query.isError && !trade && (
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="properties-no-linked-trade">
            <p className="text-sm text-muted-foreground">{copy.unlinked}</p>
            {["Owner", "Developer"].includes(role) && (
              <Link href="/properties/po-import">
                <Button variant="outline">{copy.importPo}</Button>
              </Link>
            )}
          </div>
        )}
        {canRead && trade && (
          <>
            <div className="grid gap-2 rounded-md border p-3 text-sm sm:grid-cols-3" data-testid="properties-trade-summary">
              <div><span className="text-muted-foreground">{copy.destination}</span><p className="font-semibold">#{trade.destinationCompanyId}</p></div>
              <div><span className="text-muted-foreground">{copy.landed}</span><p className="font-semibold">{Number(trade.landedCost).toFixed(2)} USD</p></div>
              <div><span className="text-muted-foreground">{copy.status}</span><p className="font-semibold">{status}</p></div>
            </div>
            <p className="text-xs text-muted-foreground">{closed ? copy.closed : copy.confirm}</p>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="flex h-auto flex-wrap">
                <TabsTrigger value="linked" disabled={closed} data-testid="tab-properties-linked-po">{copy.linkedTab}</TabsTrigger>
                <TabsTrigger value="lifecycle" data-testid="tab-properties-receive-cancel">{copy.lifecycleTab}</TabsTrigger>
              </TabsList>
              <TabsContent value="linked">
                {!closed && (
                  <Suspense fallback={<p className="text-sm text-muted-foreground">{copy.loading}</p>}>
                    <LinkedTradesEditor physicalContainerId={containerId} embedded />
                  </Suspense>
                )}
              </TabsContent>
              <TabsContent value="lifecycle">
                <Suspense fallback={<p className="text-sm text-muted-foreground">{copy.loading}</p>}>
                  <IntercompanyLifecycle physicalContainerId={containerId} embedded />
                </Suspense>
              </TabsContent>
            </Tabs>
          </>
        )}
      </CardContent>
    </Card>
  );
}
