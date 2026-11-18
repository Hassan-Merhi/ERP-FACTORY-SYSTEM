// Extracted from ./PropertiesContainerTrading.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguageCode } from "@/contexts/ApplicationLanguageContext";
import { intercompanyTradingSetupText } from "@/i18n/intercompanyTradingSetupTranslations";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";

interface Account {
  id: number;
  companyId: number;
  code: string;
  name: string;
  accountType: string;
}

interface Supplier {
  id: number;
  companyId: number;
  legalName: string;
  code: string;
}

interface Company {
  id: number;
  name: string;
  code: string;
}

interface Policy {
  id: number;
  destinationCompanyId: number;
  tradeEnabled: boolean;
}

interface Setup {
  sourceCompanyId: number;
  destinations: Company[];
  accounts: Account[];
  suppliers: Supplier[];
  policies: Policy[];
}

interface PreviewLine {
  itemName: string;
  barcode: string | null;
  poNumber: string;
}

interface PreviewContainer {
  containerNumber: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: number;
  chargesTotal: number;
  grandTotal: number;
  items: PreviewLine[];
}

interface Preview {
  fileName: string;
  sha256: string;
  rowCount: number;
  containers: PreviewContainer[];
}

interface ImportResult {
  batchId: number;
  containerCount: number;
  totalIntercompanyCost: string;
  containers: Array<{
    containerNumber: string;
    sourcePoIds: number[];
    destinationPoId: number;
    destinationCompanyId: number;
    landedTotal: string;
  }>;
}

interface ProvisioningResult {
  relationshipId: number;
  destinationCompanyId: number;
  tradeEnabled: boolean;
  status: "configured" | "already_ready";
  createdAccounts: number;
  reusedAccounts: number;
  createdSupplier: boolean;
}

interface ContainerSelection {
  relationshipId: string;
  chargesConfirmed: boolean;
  chargeEvidenceReference: string;
}

const ENDPOINT = "/api/intercompany-container-trading";

async function apiJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({ message: "Request failed" }));
    throw new Error(payload.message || "Request failed");
  }
  return res.json() as Promise<T>;
}

export function usePropertiesContainerTradingState() {
  const { selectedCompany } = useCompany();
  const copy = intercompanyTradingSetupText(useApplicationLanguageCode());
  const { toast } = useToast();
  const [target, setTarget] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [externalSupplierId, setExternalSupplierId] = useState("");
  const [importDate, setImportDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selections, setSelections] = useState<Record<string, ContainerSelection>>({});
  const [result, setResult] = useState<ImportResult | null>(null);

  const {
    data: setup,
    isLoading,
    error: setupError,
    refetch,
  } = useQuery<Setup>({
    queryKey: companyQueryKey(ENDPOINT + "/setup", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
    queryFn: (): Promise<Setup> => apiJson(ENDPOINT + "/setup"),
    staleTime: 0,
  });

  const enabledPairs = (setup?.policies || []).filter(
    (p) => p.tradeEnabled && (setup?.destinations ?? []).some((d) => d.id === p.destinationCompanyId)
  );
  const selectedPolicy = enabledPairs.find((policy) => policy.destinationCompanyId === Number(target));

  useEffect(() => {
    setTarget("");
    setPreview(null);
    setSelections({});
    setResult(null);
    setFile(null);
    setExternalSupplierId("");
  }, [selectedCompany?.id]);

  const configure = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error(copy.chooseDestination);
      const res = await apiRequest("POST", ENDPOINT + "/relationships/auto", {
        destinationCompanyId: Number(target),
      });
      return (await res.json()) as ProvisioningResult;
    },
    onSuccess: async (data) => {
      toast({
        title: data.status === "already_ready" ? copy.setupVerified : copy.tradingReady,
        description:
          data.status === "already_ready"
            ? copy.reused
            : `${data.createdAccounts} ${copy.createdAccounts} ${data.reusedAccounts} ${copy.reusedAccounts}. ${data.createdSupplier ? copy.supplierCreated : copy.supplierReused}`,
      });
      await queryClient.invalidateQueries({ queryKey: companyQueryKey(ENDPOINT + "/setup", selectedCompany?.id) });
      await refetch();
    },
    onError: (error: Error) =>
      toast({ title: copy.automaticSetupRejected, description: error.message, variant: "destructive" }),
  });
  const previewMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("Select the original Excel workbook first");
      const body = new FormData();
      body.append("file", file);
      return apiJson<Preview>(ENDPOINT + "/preview", { method: "POST", body });
    },
    onSuccess: (data) => {
      setPreview(data);
      setResult(null);
      setSelections(
        Object.fromEntries(
          data.containers.map((container) => [
            container.containerNumber,
            {
              relationshipId: enabledPairs.length === 1 ? String(enabledPairs[0].id) : "",
              chargesConfirmed: false,
              chargeEvidenceReference: "",
            },
          ])
        )
      );
      toast({
        title: "Workbook parsed",
        description: data.containers.length + " containers. Choose one destination for each.",
      });
    },
    onError: (error: Error) => toast({ title: "Preview failed", description: error.message, variant: "destructive" }),
  });

  const importMutation = useMutation({
    mutationFn: async () => {
      if (!file || !preview || !externalSupplierId) throw new Error("Select the file and its external supplier");
      const requested = preview.containers.map((container) => {
        const choice = selections[container.containerNumber];
        if (!choice?.relationshipId) throw new Error("Choose a destination for " + container.containerNumber);
        if (
          choice.chargesConfirmed &&
          container.chargesTotal !== 0 &&
          choice.chargeEvidenceReference.trim().length < 3
        ) {
          throw new Error("Enter confirmed charge evidence for " + container.containerNumber);
        }
        return {
          containerNumber: container.containerNumber,
          relationshipId: Number(choice.relationshipId),
          chargesConfirmed: choice.chargesConfirmed,
          chargeEvidenceReference: choice.chargeEvidenceReference.trim() || undefined,
        };
      });
      const body = new FormData();
      body.append("file", file);
      body.append("externalSupplierId", externalSupplierId);
      body.append("importDate", importDate);
      body.append("selections", JSON.stringify(requested));
      return apiJson<ImportResult>(ENDPOINT + "/import", { method: "POST", body });
    },
    onSuccess: (data) => {
      setResult(data);
      toast({
        title: "Atomic import complete",
        description: data.containerCount + " linked containers and both sides posted.",
      });
      queryClient.invalidateQueries({ queryKey: companyQueryKey(ENDPOINT + "/trades", selectedCompany?.id) });
      queryClient.invalidateQueries({ queryKey: ["/api/containers"] });
    },
    onError: (error: Error) =>
      toast({
        title: "Import rejected — nothing partially posted",
        description: error.message,
        variant: "destructive",
      }),
  });

  const saveSelection = (name: string, field: keyof ContainerSelection, value: string | boolean) => {
    setSelections((old) => ({
      ...old,
      [name]: { ...old[name], [field]: value },
    }));
  };
  const sourceId = setup?.sourceCompanyId ?? Number(selectedCompany?.id ?? 0);
  return {
    configure,
    copy,
    enabledPairs,
    externalSupplierId,
    file,
    importDate,
    importMutation,
    isLoading,
    preview,
    previewMutation,
    result,
    saveSelection,
    selectedPolicy,
    selections,
    setExternalSupplierId,
    setFile,
    setImportDate,
    setPreview,
    setResult,
    setTarget,
    setup,
    setupError,
    sourceId,
    target,
  };
}
