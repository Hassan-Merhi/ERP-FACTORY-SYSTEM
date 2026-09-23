import { useCompany, type Company } from "@/contexts/CompanyContext";
import type { CompanyType } from "@/contracts/sessionContracts";
import { AlertTriangle, ChevronDown, Layers, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useConnectivity } from "@/contexts/ConnectivityContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { enqueueRequest } from "@/lib/offlineQueue";

const TYPE_META: Record<CompanyType, { color: string; label: string }> = {
  erp: { color: "#3b82f6", label: "ERP" },
  retail: { color: "#0ea5e9", label: "Retail" },
  factory: { color: "#f97316", label: "Factory" },
  factory_v2: { color: "#f97316", label: "Factory V2" },
  properties: { color: "#6366f1", label: "Properties" },
  supplier_partner: { color: "#f43f5e", label: "Supplier Partner" },
};

function getTypeMeta(type: CompanyType) {
  return TYPE_META[type];
}

function getInitials(name: string) {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return name.substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function CompanyAvatar({ name, type, size = "sm" }: { name: string; type: CompanyType; size?: "sm" | "md" }) {
  const { color } = getTypeMeta(type);
  const dim = size === "md" ? "h-7 w-7 text-[11px]" : "h-5 w-5 text-[9px]";
  return (
    <span
      className={`${dim} flex shrink-0 items-center justify-center rounded-md font-bold text-white`}
      style={{ backgroundColor: color }}
    >
      {getInitials(name)}
    </span>
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Please try again.";
}

export function CompanySelector({ showMobileName = false }: { showMobileName?: boolean } = {}) {
  const { selectedCompany, companies, isLoading, error: companyError, selectCompany } = useCompany();
  const { isOnline } = useConnectivity();
  const { t } = useApplicationLanguage();
  const { toast } = useToast();
  const mobileStatusLabelClassName = showMobileName
    ? "max-w-[7rem] truncate text-xs sm:max-w-[9rem]"
    : "hidden sm:inline";
  const singleCompanyLabelClassName = showMobileName
    ? "max-w-[7rem] truncate text-xs sm:max-w-[120px]"
    : "hidden max-w-[120px] truncate sm:inline";
  const selectorClassName = `h-10 gap-1 px-1.5 sm:h-8 sm:max-w-[8rem] sm:pr-1.5 ${
    showMobileName ? "max-w-[10rem]" : "max-w-[4.5rem]"
  }`;
  const selectorLabelClassName = showMobileName
    ? "max-w-[6.75rem] truncate text-xs sm:max-w-[72px]"
    : "hidden max-w-[72px] truncate text-xs sm:inline";

  const handleCompanyChange = async (company: Company) => {
    if (company.id === selectedCompany?.id || isLoading) return;

    try {
      const switched = await selectCompany(company, isOnline ? undefined : { offline: true });
      if (!switched) {
        toast({
          title: "Failed to switch company",
          description: "The server did not accept the workspace change. Your current company was kept.",
          variant: "destructive",
        });
        return;
      }

      if (!isOnline) {
        enqueueRequest(
          "/api/auth/set-company",
          "POST",
          JSON.stringify({ companyId: company.id }),
          `Switch to ${company.name}`
        );
        toast({
          title: `Switched to ${company.name}`,
          description: "The local workspace changed. The server session will synchronize when you reconnect.",
        });
        return;
      }

      toast({ title: `Switched to ${company.name}` });
    } catch (error: unknown) {
      toast({
        title: "Failed to switch company",
        description: getErrorMessage(error),
        variant: "destructive",
      });
    }
  };

  if (companyError) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        data-testid="button-company-selector-error"
        aria-label="Company data unavailable"
        title={companyError.message}
        className="h-10 gap-1.5 px-2 text-destructive sm:h-8"
      >
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className={mobileStatusLabelClassName}>Company unavailable</span>
      </Button>
    );
  }

  if (isLoading || !selectedCompany) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        data-testid="button-company-selector"
        aria-label={t("company.loadingSelector")}
        className="h-10 gap-1.5 px-2 sm:h-8"
      >
        <span className="h-5 w-5 shrink-0 animate-pulse rounded-md bg-muted" />
        <span className={mobileStatusLabelClassName}>Loading…</span>
      </Button>
    );
  }

  const activeType = selectedCompany.companyType;

  if (companies.length <= 1) {
    return (
      <Button
        variant="outline"
        size="sm"
        disabled
        data-testid="button-company-selector"
        aria-label={[t("company.current"), selectedCompany.name].join(": ")}
        title={selectedCompany.name}
        className="h-10 gap-1.5 px-2 sm:h-8"
      >
        <CompanyAvatar name={selectedCompany.name} type={activeType} />
        <span className={singleCompanyLabelClassName}>{selectedCompany.name}</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          data-testid="button-company-selector"
          aria-label={[[t("company.current"), selectedCompany.name].join(": "), t("company.openSwitcher")].join(". ")}
          title={selectedCompany.name}
          className={selectorClassName}
        >
          {isOnline ? (
            <CompanyAvatar name={selectedCompany.name} type={activeType} />
          ) : (
            <WifiOff className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <span className={selectorLabelClassName}>{selectedCompany.name}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        sideOffset={8}
        collisionPadding={8}
        className="max-h-[calc(var(--app-viewport-height)_-_1rem)] w-[calc(100vw_-_1rem)] max-w-80 overflow-y-auto p-1.5 sm:max-h-[32rem]"
      >
        <div className="mb-1 flex items-center justify-between px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Layers className="h-3.5 w-3.5" />
            <span className="text-xs font-semibold uppercase tracking-wider">Switch workspace</span>
          </div>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {companies.length}
          </Badge>
        </div>

        {!isOnline && (
          <div className="mb-1 flex items-center gap-1.5 rounded-md bg-muted/50 px-2 py-2 text-xs text-muted-foreground">
            <WifiOff className="h-3 w-3 shrink-0" />
            Offline — switch will sync on reconnect
          </div>
        )}

        <DropdownMenuSeparator className="mx-0 my-1" />

        {companies.map((company) => {
          const { color, label } = getTypeMeta(company.companyType);
          const isActive = company.id === selectedCompany.id;

          return (
            <DropdownMenuItem
              key={company.id}
              onClick={() => handleCompanyChange(company)}
              data-testid={`company-option-${company.id}`}
              className="min-h-11 cursor-pointer gap-2.5 rounded-md px-2 py-2"
              style={isActive ? { backgroundColor: `${color}14` } : undefined}
            >
              <CompanyAvatar name={company.name} type={company.companyType} size="md" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium leading-tight">{company.name}</span>
                <span className="text-[10px] leading-tight" style={{ color: `${color}cc` }}>
                  {label}
                </span>
              </div>
              {isActive && (
                <span
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full"
                  style={{ backgroundColor: color }}
                >
                  <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" aria-hidden="true">
                    <polyline
                      points="1.5,5 4,7.5 8.5,2.5"
                      stroke="white"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
