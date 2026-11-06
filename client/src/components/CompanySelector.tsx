import { useCompany, type Company } from "@/contexts/CompanyContext";
import type { CompanyType } from "@/contracts/sessionContracts";
import { AlertTriangle, Check, ChevronDown, Layers, Search, WifiOff } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  const dim =
    size === "md"
      ? "h-9 w-9 rounded-[11px] text-[11px] shadow-[0_3px_10px_rgba(22,45,96,0.16)] ring-1 ring-white/35"
      : "h-5 w-5 rounded-md text-[11px]";
  return (
    <span
      className={`${dim} relative flex shrink-0 items-center justify-center overflow-hidden font-bold text-white shadow-inner`}
      style={{ background: `linear-gradient(145deg, ${color}, ${color}c9)` }}
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
  const [searchTerm, setSearchTerm] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const firstOptionRef = useRef<HTMLDivElement>(null);
  const mobileStatusLabelClassName = showMobileName ? "max-w-28 truncate text-xs sm:max-w-36" : "hidden sm:inline";
  const singleCompanyLabelClassName = showMobileName
    ? "max-w-28 truncate text-xs sm:max-w-[120px]"
    : "hidden max-w-[120px] truncate sm:inline";
  const selectorClassName = `h-10 min-w-0 gap-1 px-1.5 sm:h-8 sm:max-w-32 sm:pr-1.5 ${
    showMobileName ? "max-w-40" : "max-w-18"
  }`;
  const selectorLabelClassName = showMobileName
    ? "max-w-27 truncate text-xs sm:max-w-[72px]"
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
  const query = searchTerm.trim().toLocaleLowerCase();
  const filteredCompanies = companies.filter((company) =>
    `${company.name} ${getTypeMeta(company.companyType).label}`.toLocaleLowerCase().includes(query)
  );

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
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) setSearchTerm("");
        else window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }}
    >
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
        sideOffset={10}
        collisionPadding={8}
        data-testid="workspace-switcher-content"
        className="relative isolate flex max-h-[min(34rem,calc(var(--app-viewport-height)-1rem))] w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-[19px] border border-slate-200/80 bg-[linear-gradient(145deg,rgba(248,251,255,.99),rgba(241,245,255,.99)_60%,rgba(247,244,255,.99))] p-0 text-slate-900 shadow-[0_18px_48px_-16px_rgba(41,76,153,.35),0_3px_12px_rgba(40,64,135,.09)] backdrop-blur-xl dark:border-indigo-300/15 dark:bg-[linear-gradient(145deg,rgba(13,24,50,.99),rgba(23,24,56,.99)_60%,rgba(33,22,59,.99))] dark:text-slate-50 dark:shadow-[0_18px_55px_-18px_rgba(0,0,0,.75),0_0_24px_rgba(107,84,230,.08)]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 -right-12 -z-10 h-48 w-48 rounded-full bg-violet-300/25 blur-3xl dark:bg-violet-500/10"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-20 top-24 -z-10 h-44 w-44 rounded-full bg-sky-300/25 blur-3xl dark:bg-blue-500/10"
        />
        <div className="relative shrink-0 border-b border-slate-200/70 px-3.5 pb-3 pt-3 dark:border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[11px] border border-blue-200/80 bg-[linear-gradient(135deg,#fff,#dce7ff_60%,#e8ddff)] text-blue-600 shadow-[0_3px_10px_rgba(74,100,174,.12)] dark:border-indigo-300/20 dark:bg-[linear-gradient(135deg,#34466f,#252a5d)] dark:text-blue-300">
              <Layers className="h-4 w-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 text-[12px] font-bold uppercase tracking-[.075em] text-slate-900 dark:text-slate-100">
              Switch workspace
            </div>
            <div
              className="rounded-full bg-gradient-to-r from-blue-600 to-violet-600 px-2.5 py-0.5 text-[11px] font-bold text-white shadow-[0_3px_9px_rgba(86,99,230,.2)]"
              aria-label={`${companies.length} workspaces`}
            >
              {companies.length}
            </div>
          </div>
          <div className="relative mt-2.5">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-slate-400"
              aria-hidden="true"
            />
            <input
              type="search"
              ref={searchInputRef}
              data-testid="workspace-switcher-search"
              aria-label="Search workspaces"
              autoComplete="off"
              placeholder="Search workspace..."
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              onKeyDown={(event) => {
                if (["ArrowDown", "ArrowUp", "Enter"].includes(event.key) && filteredCompanies.length) {
                  event.preventDefault();
                  event.stopPropagation();
                  firstOptionRef.current?.focus();
                } else if (event.key !== "Escape" && event.key !== "Tab") {
                  // Keep Radix menu typeahead from intercepting search input text.
                  event.stopPropagation();
                }
              }}
              className="h-9 w-full rounded-xl border border-slate-200/90 bg-white/60 pl-9 pr-3 text-[13px] text-slate-900 outline-none shadow-[inset_0_1px_3px_rgba(62,78,150,.05)] placeholder:text-slate-500 focus-visible:border-blue-400 focus-visible:ring-2 focus-visible:ring-blue-400/30 dark:border-white/15 dark:bg-white/[.07] dark:text-white dark:placeholder:text-slate-400 dark:focus-visible:border-blue-400"
            />
          </div>
          {!isOnline && (
            <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-amber-300/50 bg-amber-50/80 px-2.5 py-2 text-[11px] text-amber-900 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">
              <WifiOff className="h-3.5 w-3.5 shrink-0" />
              Offline — switch will sync on reconnect
            </div>
          )}
        </div>

        <div
          role="group"
          aria-label="Available workspaces"
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain px-2.5 pb-2.5 pt-2.5 [scrollbar-color:#a8b8de_transparent] [scrollbar-width:thin] dark:[scrollbar-color:#576489_transparent] sm:px-3"
        >
          {filteredCompanies.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-slate-600 dark:text-slate-300">
              No matching workspaces
            </div>
          )}
          {filteredCompanies.map((company, index) => {
            const { color, label } = getTypeMeta(company.companyType);
            const isActive = company.id === selectedCompany.id;

            return (
              <DropdownMenuItem
                key={company.id}
                ref={index === 0 ? firstOptionRef : undefined}
                onClick={() => void handleCompanyChange(company)}
                onKeyDown={(event) => {
                  if (index === 0 && event.key === "ArrowUp") {
                    event.preventDefault();
                    event.stopPropagation();
                    searchInputRef.current?.focus();
                  }
                }}
                data-testid={`company-option-${company.id}`}
                aria-current={isActive ? "true" : undefined}
                className={`relative min-h-[48px] cursor-pointer gap-2.5 rounded-[13px] border px-2.5 py-1.5 outline-none transition-[background-color,border-color,box-shadow] duration-150 focus:bg-blue-100/85 focus:text-slate-950 dark:focus:bg-white/15 dark:focus:text-white ${
                  isActive
                    ? "border-blue-500/75 bg-gradient-to-r from-blue-100/90 via-indigo-100/85 to-violet-100/85 text-slate-950 shadow-[0_0_0_1px_rgba(59,130,246,.18),0_3px_12px_rgba(99,102,241,.09)] dark:border-blue-400/75 dark:bg-[linear-gradient(100deg,rgba(37,82,165,.40),rgba(83,54,151,.38))] dark:text-white dark:shadow-[0_0_0_1px_rgba(96,165,250,.16),0_3px_12px_rgba(76,68,177,.12)]"
                    : "border-slate-200/75 bg-white/45 text-slate-900 hover:border-blue-300/80 hover:bg-blue-50/85 dark:border-white/10 dark:bg-white/[.045] dark:text-slate-100 dark:hover:border-blue-400/35 dark:hover:bg-white/[.09]"
                }`}
              >
                <CompanyAvatar name={company.name} type={company.companyType} size="md" />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-[12px] font-semibold leading-tight sm:text-[13px]">
                    {company.name}
                  </span>
                  <span className="text-[10px] font-medium leading-tight dark:brightness-125" style={{ color }}>
                    {label}
                  </span>
                </div>
                {isActive && (
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-white shadow-[0_2px_8px_rgba(59,102,234,.25)] ring-1 ring-white/65 dark:ring-white/20"
                    aria-label="Current workspace"
                  >
                    <Check className="h-3.5 w-3.5 stroke-[3]" aria-hidden="true" />
                  </span>
                )}
              </DropdownMenuItem>
            );
          })}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
