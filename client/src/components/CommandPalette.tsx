import { useEffect, useState, useCallback, useMemo } from "react";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { LayoutDashboard, ShoppingCart, Settings, ArrowRight, Sparkles } from "lucide-react";
import { useAppMode } from "@/contexts/AppModeContext";
import { isRetailHiddenErpPath, useErpVisibleSections } from "@/components/AppSidebar";
import { useCompany } from "@/contexts/CompanyContext";
import { useFactoryVisibleSections } from "@/components/FactorySidebar";
import { getPropertiesVisibleNavSections } from "@/components/PropertiesSidebar";
import { canNavigateProperties, canUsePropertiesCapability } from "@/properties/config/propertiesNavigation";
import {
  ERP_ACCOUNTING_CONTEXT_ITEMS,
  ERP_CONTEXT_ITEMS,
  ERP_EXTRAS,
  ERP_HUB_TABS,
  FACTORY_ACCOUNTING_CONTEXT,
  FACTORY_CONTEXT_SEARCH,
  FACTORY_EXTRAS_ALWAYS,
  FACTORY_MAINTENANCE_CONTEXT,
  PROPERTIES_ACCOUNTING_CONTEXT,
  PROPERTIES_MAINTENANCE_CONTEXT,
  type CommandPaletteProps,
  type PageEntry,
} from "./CommandPaletteDESCRIPTIONS";
import {
  FACTORY_HUB_TABS,
  PROPERTIES_ADMIN_EXTRAS,
  PROPERTIES_DEVELOPER_EXTRAS,
  PROPERTIES_EXTRAS,
  adminPages,
  factoryAdminPages,
} from "./commandPaletteHubTabs";
import { posPages } from "./CommandPalettePosPages";
import { buildEntries, PaletteItem } from "./CommandPaletteParts";

const intercompanyPages: PageEntry[] = [
  {
    label: "Intercompany Requests",
    description: "Review and approve intercompany payment notifications",
    path: "/intercompany-requests",
    icon: ArrowRight,
  },
];
const retailPosPages: PageEntry[] = [
  { label: "Retail POS", description: "Retail checkout", path: "/retail/pos", icon: ShoppingCart },
  { label: "My Settings", description: "Personal preferences", path: "/my-settings", icon: Settings },
];

export function CommandPalette({
  open: externalOpen,
  onOpenChange: externalOnOpenChange,
  isPOS = false,
  hasErpAccess = true,
  hasFactoryAccess = false,
  hasPropertiesAccess = false,
  isAdminOwner = false,
  user,
}: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const appMode = useAppMode();
  const [, setLocation] = useLocation();
  const effectiveRole = user?.currentRole ?? user?.role ?? "";
  // FactoryRoutes and PropertiesRoutes guard pages using user.role; their
  // command search must not grant a route based on a different role field.
  const shellRole = appMode === "factory" || appMode === "properties" ? (user?.role ?? "") : effectiveRole;
  const canSeeAdminCommands = shellRole === "Admin" || shellRole === "Developer";

  const isControlled = externalOpen !== undefined;
  const open = isControlled ? externalOpen : internalOpen;
  const setOpen = useCallback(
    (value: boolean) => {
      if (!isControlled) setInternalOpen(value);
      externalOnOpenChange?.(value);
    },
    [isControlled, externalOnOpenChange]
  );

  useEffect(() => {
    if (!isAdminOwner) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        setOpen(!open);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, setOpen, isAdminOwner]);

  const navigate = useCallback(
    (path: string) => {
      setOpen(false);
      setLocation(path);
    },
    [setOpen, setLocation]
  );

  const { selectedCompany } = useCompany();
  const erpVis = useErpVisibleSections(hasErpAccess && !isPOS ? user : undefined);
  const factoryVis = useFactoryVisibleSections(
    hasFactoryAccess && !isPOS && user ? { role: user.role ?? undefined } : undefined
  );

  const isRetailCompany = selectedCompany?.companyType === "retail";
  const {
    sections: erpSections,
    visiblePinnedItems: erpPinnedItems,
    visibleUtilityItems: erpUtilityItems,
    isItemVisible: erpIsItemVisible,
  } = erpVis;
  const {
    sections: factorySections,
    isPinnedVisible: factoryIsPinnedVisible,
    isHubTabVisible: factoryIsHubTabVisible,
  } = factoryVis;
  const erpPages = useMemo(
    () =>
      buildEntries(
        erpSections,
        [
          ...ERP_EXTRAS.filter((entry) => {
            if (entry.path === "/") return canSeeAdminCommands;
            return erpIsItemVisible({ title: entry.label, url: entry.path, icon: LayoutDashboard });
          }),
          // A link to one part of a composite hub must not disclose another
          // part that this user's actual ERP feature grants don't permit.
          ...ERP_HUB_TABS.filter((tab) => {
            if (isRetailCompany && isRetailHiddenErpPath(tab.path)) return false;
            const accessPath =
              tab.path === "/parties?tab=suppliers"
                ? "/suppliers"
                : tab.path === "/parties?tab=customers"
                  ? "/customers"
                  : tab.path;
            return erpIsItemVisible({ title: tab.label, url: accessPath, icon: LayoutDashboard });
          }),
        ],
        [
          ...erpPinnedItems,
          ...erpUtilityItems,
          ...ERP_CONTEXT_ITEMS.filter((item) => erpIsItemVisible(item)),
          ...ERP_ACCOUNTING_CONTEXT_ITEMS.filter((item) => erpIsItemVisible(item)),
        ]
      ).map((page) =>
        isRetailCompany && page.path === "/vouchers"
          ? { ...page, description: "Payment and receipt vouchers; automatic journals are read-only" }
          : page
      ),
    [erpSections, erpPinnedItems, erpUtilityItems, erpIsItemVisible, isRetailCompany, canSeeAdminCommands]
  );

  const factoryPages = useMemo(() => {
    const accessibleExtras = [...FACTORY_EXTRAS_ALWAYS, ...FACTORY_CONTEXT_SEARCH, ...FACTORY_HUB_TABS].filter(
      (entry) => factoryIsPinnedVisible({ url: entry.path }) && factoryIsHubTabVisible(entry.path)
    );
    return buildEntries(factorySections, [
      ...accessibleExtras,
      ...(shellRole === "Developer" ? [...FACTORY_ACCOUNTING_CONTEXT, ...FACTORY_MAINTENANCE_CONTEXT] : []),
    ]);
  }, [factorySections, factoryIsPinnedVisible, factoryIsHubTabVisible, shellRole]);

  const propertiesPages = useMemo(() => {
    const canDeveloper = canUsePropertiesCapability("developer", user, selectedCompany);
    const canAdmin = canUsePropertiesCapability("admin", user, selectedCompany);
    const candidateExtras = [
      ...PROPERTIES_EXTRAS,
      ...(canDeveloper
        ? [...PROPERTIES_DEVELOPER_EXTRAS, ...PROPERTIES_ACCOUNTING_CONTEXT, ...PROPERTIES_MAINTENANCE_CONTEXT]
        : []),
      ...(canAdmin ? PROPERTIES_ADMIN_EXTRAS : []),
    ];
    return buildEntries(
      getPropertiesVisibleNavSections(canDeveloper),
      candidateExtras.filter((entry) => canNavigateProperties(entry.path, user, selectedCompany))
    );
  }, [user, selectedCompany]);

  const showErp = !isPOS && hasErpAccess;
  const showFactory = !isPOS && hasFactoryAccess;
  const showProperties = !isPOS && hasPropertiesAccess;
  // Global admin routes (e.g. /settings, /deleted-items) only work in ERP/Factory shells.
  // In properties-only mode, suppress them since the properties shell redirects away.
  const showAdmin = !isPOS && canSeeAdminCommands && (showErp || showFactory);
  // Entries whose page lives only in ErpRoutes are dropped outside the ERP
  // shell: under a factory company the guard redirects the unprefixed path away,
  // so offering them means offering a command that goes somewhere else.
  const visibleAdminPages = useMemo(
    () =>
      appMode === "factory" ? factoryAdminPages : adminPages.filter((page) => !page.erpShellOnly || appMode === "erp"),
    [appMode]
  );
  const showIntercompany = !isPOS && (showErp || showFactory);

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Search pages..." data-testid="input-command-palette" />
      <CommandList className="max-h-[420px]">
        <CommandEmpty>No pages found.</CommandEmpty>

        {isPOS && (
          <CommandGroup heading="POS">
            {(isRetailCompany ? retailPosPages : posPages).map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showErp && (
          <CommandGroup heading="ERP">
            {erpPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showErp && showFactory && <CommandSeparator />}

        {showFactory && (
          <CommandGroup heading="Factory">
            {factoryPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {(showErp || showFactory) && showProperties && <CommandSeparator />}

        {showProperties && (
          <CommandGroup heading="Properties">
            {propertiesPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showAdmin && <CommandSeparator />}

        {showAdmin && (
          <CommandGroup heading="Admin & Settings">
            {visibleAdminPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        {showIntercompany && <CommandSeparator />}
        {showIntercompany && (
          <CommandGroup heading="Intercompany">
            {intercompanyPages.map((p) => (
              <PaletteItem key={p.path} page={p} onSelect={navigate} />
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />
        <CommandGroup heading="AI Assistant">
          <CommandItem
            onSelect={() => {
              setOpen(false);
              window.dispatchEvent(new CustomEvent("openAIChat", { detail: { prefill: "" } }));
            }}
            data-testid="command-ask-ai"
          >
            <Sparkles className="mr-2 h-4 w-4 text-primary" />
            <div className="flex flex-col">
              <span>Ask AI Assistant</span>
              <span className="text-xs text-muted-foreground">Open the ERP AI chatbot</span>
            </div>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
