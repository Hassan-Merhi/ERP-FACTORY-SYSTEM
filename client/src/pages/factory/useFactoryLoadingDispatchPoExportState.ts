// Extracted from ./FactoryLoadingDispatchPoExport.tsx
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { downloadFromUrl, exportFileName } from "@/lib/exportFile";
import {
  emptyCharges,
  chargeFields,
  isMoney,
  canExport,
  errorMessage,
  readJson,
  type Charges,
  type Setup,
  type Preview,
  type Props,
} from "./FactoryLoadingDispatchPoExportHelpers";

export function useFactoryLoadingDispatchPoExportState({
  orderId,
  dispatchId,
  companyId,
  role,
  status,
}: Pick<Props, "orderId" | "dispatchId" | "companyId" | "role" | "status">) {
  const { toast } = useToast();
  const [supplierCode, setSupplierCode] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [charges, setCharges] = useState<Charges>(emptyCharges());
  const [ratesReviewed, setRatesReviewed] = useState(false);
  const [chargesReviewed, setChargesReviewed] = useState(false);
  const [previewResult, setPreviewResult] = useState<Preview | null>(null);
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const setupUrl = base + "/po-export/setup";
  const enabled = Boolean(companyId) && status === "CLOSED" && canExport(role);
  const setup = useQuery<Setup>({
    queryKey: companyQueryKey(setupUrl, companyId),
    queryFn: () => readJson<Setup>(setupUrl),
    enabled,
    staleTime: 15000,
    refetchOnWindowFocus: false,
  });
  const source = setup.data;
  const frozen = Boolean(source?.previousExport);
  useEffect(() => {
    if (!source) return;
    const prior = source.previousExport;
    setSupplierCode(prior?.supplierCode ?? "");
    setRates(Object.fromEntries((prior?.preview.rates ?? []).map((r) => [r.articleCode, r.rate])));
    setCharges(prior?.preview.charges ?? source.suggested.charges ?? emptyCharges());
    setRatesReviewed(false);
    setChargesReviewed(false);
    setPreviewResult(null);
    // Reset only when the frozen source or prior export changes identity,
    // not on every refetch that returns an equal object.
  }, [source?.sourceFingerprint, source?.revision, source?.previousExport?.exportFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  const choice = () => ({
    supplierCode: supplierCode.trim(),
    rates: (source?.articles ?? []).map((a) => ({
      articleCode: a.articleCode,
      rate: rates[a.articleCode]?.trim() ?? "",
    })),
    charges: Object.fromEntries(chargeFields.map((c) => [c.key, charges[c.key].trim()])) as unknown as Charges,
  });
  const payload = () => ({
    expectedSourceFingerprint: source?.sourceFingerprint,
    expectedRevision: source?.revision,
    choice: choice(),
  });
  const valid = Boolean(
    source &&
    source.articles.length > 0 &&
    supplierCode.trim().length > 0 &&
    supplierCode.trim().length <= 100 &&
    source.articles.every((a) => isMoney(rates[a.articleCode] ?? "", true)) &&
    chargeFields.every((c) => isMoney(charges[c.key]))
  );
  const change = () => {
    setPreviewResult(null);
    setRatesReviewed(false);
    setChargesReviewed(false);
  };
  const preview = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", base + "/po-export/preview", payload());
      return response.json() as Promise<Preview>;
    },
    onSuccess: (data) => {
      setPreviewResult(data);
      setRatesReviewed(false);
      setChargesReviewed(false);
    },
    onError: (error) => {
      setPreviewResult(null);
      toast({ title: "PO preview refused", description: errorMessage(error), variant: "destructive" });
    },
  });
  const download = useMutation({
    mutationFn: async () => {
      if (!source || !previewResult || !ratesReviewed || !chargesReviewed) {
        throw new Error("Preview and explicitly review the ERP purchase values first");
      }
      await downloadFromUrl(base + "/po-export/download", {
        method: "POST",
        body: {
          ...payload(),
          expectedExportFingerprint: previewResult.exportFingerprint,
          confirmRatesReviewed: true,
          confirmChargesReviewed: true,
        },
        fileName: exportFileName("factory erp po " + previewResult.containerNumber, "xlsx"),
        preferLocalFileName: true,
      });
    },
    onSuccess: () => {
      toast({
        title: "ERP PO Excel generated",
        description:
          "This file has NOT been imported into ERP. Switch to Normal ERP → PO Import to upload and validate it.",
      });
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(setupUrl, companyId) });
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(base + "/financial-history", companyId) });
    },
    onError: (error) =>
      toast({
        title: "Export failed",
        description: errorMessage(error),
        variant: "destructive",
      }),
  });
  const pending = preview.isPending || download.isPending;
  return {
    supplierCode,
    setSupplierCode,
    rates,
    setRates,
    charges,
    setCharges,
    ratesReviewed,
    setRatesReviewed,
    chargesReviewed,
    setChargesReviewed,
    previewResult,
    enabled,
    setup,
    source,
    frozen,
    valid,
    change,
    preview,
    download,
    pending,
  };
}
