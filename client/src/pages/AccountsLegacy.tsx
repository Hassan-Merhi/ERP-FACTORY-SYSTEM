/**
 * Accounts Overview (legacy) page shell.
 *
 * Keeps its route and default export. State, queries, mutations and forms live
 * in ./accountslegacy/useAccountsLegacyModel; the search results, find-voucher
 * tab, alter-account dialog and destructive confirmations are separate views
 * under ./accountslegacy. The account table, statement view and the existing
 * AccountDialogs bundle are unchanged.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Layers, Plus, Search, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/PageHeader";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { ErrorState } from "@/components/ui/page-state";
import { AccountDialogs } from "./accounts/AccountDialogs";
import { AccountTable } from "./accounts/AccountTable";
import { useAccountDisplayOrder } from "@/hooks/useAccountDisplayOrder";
import { AccountStatementView } from "./accounts/AccountStatementView";
import type { Account, FxAgentAccountBalance } from "./accounts/accountTypes";
import { useAccountsLegacyModel } from "./accountslegacy/useAccountsLegacyModel";
import { AccountSearchResults } from "./accountslegacy/AccountSearchResults";
import { FindVoucherTab } from "./accountslegacy/FindVoucherTab";
import { EditAccountDialog } from "./accountslegacy/EditAccountDialog";
import { AccountsConfirmDialogs } from "./accountslegacy/AccountsConfirmDialogs";
import type { FactoryMyAccess } from "@shared/apiTypes";
import {
  projectGoldenCoastFreshStartAccounts,
  projectGoldenCoastFreshStartStatement,
  useGoldenCoastFreshStartPresentation,
} from "./accountslegacy/goldenCoastFreshStartPresentation";

export default function Accounts() {
  const model = useAccountsLegacyModel();
  const { selectedAccount, selectedAccountIsLedger } = model;
  const accountOrder = useAccountDisplayOrder();
  const displayLayout = accountOrder.layout;
  const isPhone = useErpPhoneLayout();
  // An open statement owns the phone screen: its own header carries Back and the statement actions.
  const phoneStatementOpen = isPhone && !!selectedAccount;
  const { data: myAccess } = useQuery<FactoryMyAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
    enabled: model.appMode === "factory",
  });
  const hiddenTabs = model.appMode === "factory" ? (myAccess?.hiddenCostFields ?? []) : [];
  const showViewAccounts = !hiddenTabs.includes("hide_tab_accounts_view");
  const showFindVoucher = !hiddenTabs.includes("hide_tab_accounts_find_voucher");
  const visibleAccountTabs = [showViewAccounts ? "view" : null, showFindVoucher ? "find" : null].filter(
    (value): value is "view" | "find" => value !== null
  );
  const [requestedAccountTab, setRequestedAccountTab] = useState<"view" | "find">("view");
  const activeAccountTab = visibleAccountTabs.includes(requestedAccountTab)
    ? requestedAccountTab
    : visibleAccountTabs[0];

  useEffect(() => {
    if (activeAccountTab && requestedAccountTab !== activeAccountTab) {
      setRequestedAccountTab(activeAccountTab);
    }
  }, [activeAccountTab, requestedAccountTab]);

  // Native FX funds are a presentation layer on top of historical USD vouchers.
  // Never replace the book balance used by account groups or statement maths.
  const { data: fxAgentData } = useQuery<{
    wallets: Array<{ wallet: { ledgerAccountId: number } } & FxAgentAccountBalance>;
  }>({
    queryKey: ["/api/factory/fx-agent-wallets", model.selectedCompany?.id, model.periodFilter.toDate || null],
    enabled: model.appMode === "factory" && !!model.selectedCompany?.id && showViewAccounts,
    staleTime: 30_000,
    queryFn: async () => {
      const params = new URLSearchParams();
      if (model.periodFilter.toDate) params.set("asOf", model.periodFilter.toDate);
      const response = await fetch("/api/factory/fx-agent-wallets?" + params.toString(), {
        credentials: "include",
      });
      if (!response.ok) throw new Error("FX wallet balances could not be loaded");
      return response.json();
    },
  });
  const walletByLedgerId = new Map(
    (fxAgentData?.wallets ?? []).map((snapshot) => [snapshot.wallet.ledgerAccountId, snapshot])
  );
  const withFxWallet = (account: Account): Account => {
    if (model.appMode !== "factory" || account.type !== "ledger") return account;
    const fxWallet = walletByLedgerId.get(account.accountId);
    return fxWallet ? { ...account, fxWallet } : account;
  };

  const freshStartAccount = model.allAccounts.find(
    (account) => account.subType === "gc_partner_capital" && account.active !== false
  );
  const freshStartPresentation = useGoldenCoastFreshStartPresentation({
    accountId: freshStartAccount?.accountId,
    subType: freshStartAccount?.subType,
    toDate: model.periodFilter.toDate || null,
  });

  // Golden Coast Net Position owns the Fresh Start residual presentation. The
  // stored equity opening remains untouched in the ledger; this page only
  // projects the list and statement so every visible Fresh Start balance agrees
  // with the Net Position figure for the same as-of date.
  const presentedFilteredAccounts = projectGoldenCoastFreshStartAccounts(
    model.filteredAccounts,
    freshStartPresentation
  );
  // Insurance creates one technical ledger per member ("Insurance - <name>").
  // Those ledgers are required for posting/history, but they are implementation
  // details and should not clutter the Factory Accounts list or account search.
  // Keep the aggregate insurance expense/accounting ledgers visible.
  const visibleFilteredAccounts =
    model.appMode === "factory"
      ? presentedFilteredAccounts
          .filter((account) => !account.name.trim().toLocaleLowerCase().startsWith("insurance - "))
          .map(withFxWallet)
      : presentedFilteredAccounts;
  const selectedFreshStartPresentation =
    selectedAccount?.subType === "gc_partner_capital" && selectedAccount.accountId === freshStartAccount?.accountId
      ? freshStartPresentation
      : null;
  const presentedSelectedAccount = selectedAccount
    ? withFxWallet(projectGoldenCoastFreshStartAccounts([selectedAccount], selectedFreshStartPresentation)[0])
    : null;
  const presentedStatement = projectGoldenCoastFreshStartStatement({
    openingBalance: model.broughtForwardBalance,
    closingBalance: model.closingBalance,
    vouchersWithBalance: model.vouchersWithBalance,
    presentation: selectedFreshStartPresentation,
  });
  const presentedSearchModel = { ...model, filteredAccounts: visibleFilteredAccounts };

  const closeSelectedAccount = () => {
    model.setSelectedAccount(null);

    // Accounts can be opened through a deep-link such as
    // ?accountId=123&accountType=ledger. If those parameters remain in the URL,
    // useAccountsLegacyModel immediately auto-selects the same account again after
    // the X button clears local state. Remove the statement-specific parameters at
    // the same time so closing actually returns to the account list.
    const params = new URLSearchParams(window.location.search);
    params.delete("accountId");
    params.delete("accountType");
    params.delete("startDate");
    params.delete("endDate");
    const nextSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      nextSearch ? `${window.location.pathname}?${nextSearch}` : window.location.pathname
    );
  };

  const unifiedAccountingLinks = [
    { testId: "button-open-items", label: "Open Items", path: "open-items" },
    { testId: "button-cash-bank-reconciliation", label: "Cash & Bank Reconciliation", path: "cash-bank" },
    { testId: "button-monetary-fx", label: "Multi-Currency Accounting", path: "monetary-fx" },
    ...(model.modePrefix !== "/properties"
      ? [
          {
            testId: "button-factory-production-accounting",
            label: "Factory Production Accounting",
            path: model.modePrefix === "/factory" ? "production" : "factory-production",
          },
        ]
      : []),
    { testId: "button-unified-rental-accounting", label: "Rental Accounting", path: "rentals" },
    { testId: "button-group-consolidation", label: "Intercompany & Consolidation", path: "consolidation" },
    { testId: "button-historical-accounting", label: "Historical Accounting", path: "history" },
    { testId: "button-professional-financial-statements", label: "Financial Statements", path: "statements" },
    { testId: "button-fiscal-review", label: "Fiscal Closing & Audit", path: "fiscal-review" },
    { testId: "button-unified-accounting-dashboard", label: "Unified Accounting Dashboard", path: "dashboard" },
    { testId: "button-unified-accounting-rollout", label: "Unified Accounting Rollout", path: "rollout" },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Accounts Overview" subtitle="View all accounts, balances, and transaction history">
        {showViewAccounts &&
          !phoneStatementOpen &&
          ["Admin", "Owner", "Developer"].includes(model.currentUser?.role ?? "") && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" data-testid="button-unified-accounting-menu">
                  Unified Accounting
                  <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {unifiedAccountingLinks.map((link) => (
                  <DropdownMenuItem
                    key={link.testId}
                    data-testid={link.testId}
                    onSelect={() => model.navigate(`${model.modePrefix}/accounting/${link.path}`)}
                  >
                    {link.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        {showViewAccounts &&
          !phoneStatementOpen &&
          (model.currentUser?.role === "Admin" || model.currentUser?.role === "Developer") && (
            <Button
              variant="outline"
              data-testid="button-account-groups"
              onClick={() => model.navigate(`${model.modePrefix}/account-groups`)}
            >
              <Layers className="w-4 h-4 mr-2" /> Account Groups
            </Button>
          )}
        {showViewAccounts && !phoneStatementOpen && (
          <Button
            data-testid="button-create-account"
            disabled={!model.selectedCompany}
            onClick={() => model.navigate(`${model.modePrefix}/create`)}
          >
            <Plus className="w-4 h-4 mr-2" /> Create
          </Button>
        )}
      </PageHeader>

      {showViewAccounts && (
        <AccountDialogs
          bankToEdit={model.bankToEdit}
          setBankToEdit={model.setBankToEdit}
          bankForm={model.bankForm}
          onBankSubmit={model.onBankSubmit}
          updateBankMutation={model.updateBankMutation}
          deleteBankMutation={model.deleteBankMutation}
          handleDeleteBankAccount={model.handleDeleteBankAccount}
          accountToEdit={model.accountToEdit}
          setAccountToEdit={model.setAccountToEdit}
          supplierToEdit={model.supplierToEdit}
          setSupplierToEdit={model.setSupplierToEdit}
          customerToEdit={model.customerToEdit}
          setCustomerToEdit={model.setCustomerToEdit}
          employeeToEdit={model.employeeToEdit}
          setEmployeeToEdit={model.setEmployeeToEdit}
          editForm={model.editForm}
          onEditSubmit={() => {}}
          updateLedgerMutation={{}}
          handleDeleteAccount={() => {}}
          pendingDelete={model.pendingDelete}
          setPendingDelete={model.setPendingDelete}
          waRuleDialogOpen={model.waRuleDialogOpen}
          setWaRuleDialogOpen={model.setWaRuleDialogOpen}
          waChatSearch={model.waChatSearch}
          setWaChatSearch={model.setWaChatSearch}
          waRuleDraft={model.waRuleDraft}
          setWaRuleDraft={model.setWaRuleDraft}
          filteredWaChats={model.filteredWaChats}
          saveWaRuleMutation={model.saveWaRuleMutation}
          waChatsLoading={model.waChatsLoading}
        />
      )}

      {activeAccountTab ? (
        <Tabs
          value={activeAccountTab}
          onValueChange={(value) => setRequestedAccountTab(value as "view" | "find")}
          className="space-y-6"
        >
          <div className={phoneStatementOpen ? "hidden" : "erp-mobile-scroll-tabs pb-1"}>
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Accounts sections">
              {showViewAccounts && <TabsTrigger value="view">View Accounts</TabsTrigger>}
              {showFindVoucher && <TabsTrigger value="find">Find Voucher</TabsTrigger>}
            </TabsList>
          </div>

          {showViewAccounts && (
            <TabsContent value="view" className="space-y-4">
              {!selectedAccount ? (
                <div className="space-y-4">
                  {/* Search — command-palette style */}
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                    <Input
                      placeholder="Search accounts by name or code…"
                      value={model.searchTerm}
                      onChange={(e) => model.setSearchTerm(e.target.value)}
                      className="pl-9 pr-9"
                      data-testid="input-accounts-search"
                    />
                    {model.searchTerm && (
                      <button
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                        onClick={() => model.setSearchTerm("")}
                        data-testid="button-accounts-search-clear"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>

                  {model.accountsLoading ? (
                    <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
                      Loading accounts…
                    </div>
                  ) : model.accountsError ? (
                    <ErrorState
                      title="Could not load accounts"
                      description={
                        model.accountsQueryError instanceof Error
                          ? model.accountsQueryError.message
                          : "Accounts could not be loaded."
                      }
                      actionLabel="Try again"
                      onAction={() => void model.refetchAccounts()}
                      data-testid="accounts-error"
                    />
                  ) : model.searchTerm && !displayLayout?.nodes?.length ? (
                    <AccountSearchResults model={presentedSearchModel} />
                  ) : (
                    /* The grouped account table also powers search, showing group headings. */
                    <AccountTable
                      filteredAccounts={visibleFilteredAccounts}
                      expandedParents={model.expandedParents}
                      toggleParent={model.toggleParent}
                      handleAccountChange={model.handleAccountChange}
                      hideBalances={model.hideBalances}
                      formatAmount={(amt) => model.formatAmountForAccount(amt, undefined)}
                      onEdit={model.openEditAccountDialog}
                      displayLayout={displayLayout}
                      searchActive={!!model.searchTerm}
                      canArrange={accountOrder.canArrange}
                      arranging={accountOrder.arranging}
                      onArrangeChange={accountOrder.setArranging}
                      onSwap={accountOrder.swap}
                      onMove={accountOrder.move}
                      isSavingOrder={accountOrder.isSaving}
                    />
                  )}
                </div>
              ) : (
                <>
                  <AccountStatementView
                    selectedAccount={presentedSelectedAccount ?? selectedAccount}
                    onClose={closeSelectedAccount}
                    periodFilter={model.periodFilter}
                    setPeriodFilter={model.setPeriodFilter}
                    vouchersWithBalance={presentedStatement.vouchersWithBalance}
                    closingBalance={presentedStatement.closingBalance}
                    openingBalance={presentedStatement.openingBalance}
                    transactionsLoading={model.transactionsLoading}
                    transactionError={(model.transactionsQueryError as Error | null)?.message ?? null}
                    selectedVoucherIds={model.selectedVoucherIds}
                    toggleSelectAll={model.toggleSelectAll}
                    setShowBulkDeleteConfirm={model.setShowBulkDeleteConfirm}
                    showDeletedVouchers={model.showDeletedVouchers}
                    setShowDeletedVouchers={model.setShowDeletedVouchers}
                    formatAmount={(amt) => model.formatAmountForAccount(amt, selectedAccount?.type)}
                    hideBalances={model.hideBalances}
                    printRef={model.printRef}
                    appMode={model.appMode}
                    formatDisplayDate={model.formatDisplayDate}
                    toggleVoucherSelection={model.toggleVoucherSelection}
                    handleOpenVoucher={model.handleOpenVoucher}
                    waRule={selectedAccountIsLedger ? (model.waRule ?? null) : null}
                    openWaRuleDialog={selectedAccountIsLedger ? model.openWaRuleDialog : () => {}}
                    sendWaStatementMutation={model.sendWaStatementMutation}
                    isBrokerSupplier={false}
                    factoryStatementLoading={false}
                    brokerStatementLoading={false}
                  />
                </>
              )}
            </TabsContent>
          )}

          {showFindVoucher && (
            <TabsContent value="find">
              <FindVoucherTab model={model} />
            </TabsContent>
          )}
        </Tabs>
      ) : (
        <div className="rounded-md border p-6 text-sm text-muted-foreground">
          No Accounts tabs are available for this user.
        </div>
      )}

      {/* ── Edit Account Dialog ─────────────────────────────────────────── */}
      {showViewAccounts && <EditAccountDialog model={model} />}

      {showViewAccounts && <AccountsConfirmDialogs model={model} />}
    </div>
  );
}
