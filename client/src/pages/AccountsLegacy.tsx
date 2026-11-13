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
import { ChevronDown, FileSearch, Layers, Plus, Search, Wallet, X } from "lucide-react";
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
import { ZambiaCashCurrencyTransfer } from "./accounts/ZambiaCashCurrencyTransfer";
import type { Account, FxAgentAccountBalance } from "./accounts/accountTypes";
import { useAccountsLegacyModel } from "./accountslegacy/useAccountsLegacyModel";
import { AccountSearchResults } from "./accountslegacy/AccountSearchResults";
import { FindVoucherTab } from "./accountslegacy/FindVoucherTab";
import { EditAccountDialog } from "./accountslegacy/EditAccountDialog";
import { AccountsConfirmDialogs } from "./accountslegacy/AccountsConfirmDialogs";
import { presentIntercompanyAccount, showInIntercompanyAccountsOverview } from "./accountslegacy/intercompanyAccountPresentation";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type { FactoryMyAccess } from "@shared/apiTypes";
import {
  projectGoldenCoastFreshStartAccounts,
  projectGoldenCoastFreshStartStatement,
  useGoldenCoastFreshStartPresentation,
} from "./accountslegacy/goldenCoastFreshStartPresentation";

export default function Accounts() {
  const model = useAccountsLegacyModel();
  // View Only and Create Only cannot edit or reorder existing accounts.
  const { allowed: canChangeExistingRecords } = useExistingRecordChangeAccess();
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
      : presentedFilteredAccounts
          .filter((account) => showInIntercompanyAccountsOverview(account, model.appMode))
          .map((account) => presentIntercompanyAccount(account, model.appMode));
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

  // Counts only, sourced from the existing as-of account list. Do not
  // modify posted balances, group structures or account queries.
  const overviewAccounts = projectGoldenCoastFreshStartAccounts(model.allAccounts, freshStartPresentation).filter(
    (account) =>
      account.type !== "displayGroup" &&
      account.subType !== "Group" &&
      (model.appMode !== "factory" || !account.name.trim().toLocaleLowerCase().startsWith("insurance - ")) &&
      showInIntercompanyAccountsOverview(account, model.appMode)
  );
  const totalAccounts = overviewAccounts.length;
  const accountsWithBalance = overviewAccounts.filter(
    (account) => Math.abs(Number(account.balance) || 0) > 0.001
  ).length;

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
    <div className="relative space-y-6 pb-6" data-testid="accounts-overview">
      <PageHeader
        title="Accounts Overview"
        subtitle="View all accounts, balances, and transaction history"
        icon={
          <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-sky-100 text-blue-700 shadow-sm shadow-blue-500/10 dark:border-blue-400/25 dark:from-blue-600/30 dark:to-blue-950 dark:text-blue-200">
            <Layers className="h-5 w-5" aria-hidden="true" />
          </span>
        }
      >
        {showViewAccounts && !phoneStatementOpen && model.currentUser?.role === "Developer" && (
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
              className="h-10 rounded-xl border-slate-200 bg-white/80 px-4 font-semibold shadow-sm transition-all hover:border-blue-300 hover:bg-blue-50 dark:border-slate-700 dark:bg-slate-900/70 dark:hover:border-blue-500/60 dark:hover:bg-blue-950/50"
              onClick={() => model.navigate(`${model.modePrefix}/account-groups`)}
            >
              <Layers className="w-4 h-4 mr-2" /> Account Groups
            </Button>
          )}
        {showViewAccounts && !phoneStatementOpen && (
          <Button
            data-testid="button-create-account"
            className="h-10 rounded-xl bg-gradient-to-r from-blue-600 to-blue-500 px-5 font-semibold text-white shadow-md shadow-blue-600/20 transition-all hover:from-blue-700 hover:to-blue-600 dark:shadow-blue-900/40"
            disabled={!model.selectedCompany}
            onClick={() => model.navigate(`${model.modePrefix}/create`)}
          >
            <Plus className="w-4 h-4 mr-2" /> Create
          </Button>
        )}
      </PageHeader>

      {showViewAccounts && activeAccountTab === "view" && !selectedAccount && !phoneStatementOpen && (
        <section
          className="grid gap-3 sm:grid-cols-2"
          aria-label="Accounts overview figures"
          data-testid="accounts-summary"
        >
          <div className="flex items-center gap-4 rounded-2xl border border-emerald-200/70 bg-gradient-to-br from-white to-emerald-50/80 p-4 shadow-sm dark:border-emerald-500/20 dark:from-[#12283a] dark:to-[#0b1d30]">
            <span className="rounded-xl bg-emerald-500/15 p-3 text-emerald-600 dark:text-emerald-400">
              <Layers className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm text-muted-foreground">Total Accounts</p>
              <p className="text-2xl font-bold tabular-nums" data-testid="accounts-total-count">
                {model.accountsLoading || model.accountsError || !model.selectedCompany
                  ? "—"
                  : totalAccounts.toLocaleString()}
              </p>
            </div>
          </div>
          {!model.hideBalances && (
            <div className="flex items-center gap-4 rounded-2xl border border-blue-200/70 bg-gradient-to-br from-white to-blue-50/80 p-4 shadow-sm dark:border-blue-500/20 dark:from-[#12283a] dark:to-[#0b1d30]">
              <span className="rounded-xl bg-blue-500/15 p-3 text-blue-600 dark:text-sky-300">
                <Wallet className="h-6 w-6" aria-hidden="true" />
              </span>
              <div>
                <p className="text-sm text-muted-foreground">Accounts with Balance</p>
                <p className="text-2xl font-bold tabular-nums" data-testid="accounts-with-balance-count">
                  {model.accountsLoading || model.accountsError || !model.selectedCompany
                    ? "—"
                    : accountsWithBalance.toLocaleString()}
                </p>
              </div>
            </div>
          )}
        </section>
      )}

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
          className="space-y-5"
        >
          <div className={phoneStatementOpen ? "hidden" : "erp-mobile-scroll-tabs pb-1"}>
            <TabsList
              className="h-auto w-max min-w-full gap-1.5 rounded-2xl border border-slate-200/90 bg-slate-100/80 p-1.5 shadow-sm sm:min-w-0 sm:w-fit dark:border-slate-700/70 dark:bg-[#152238]/90"
              aria-label="Accounts sections"
            >
              {showViewAccounts && (
                <TabsTrigger
                  value="view"
                  className="gap-2 rounded-xl px-4 py-2.5 font-semibold text-muted-foreground transition-colors data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md data-[state=active]:shadow-blue-600/20 dark:data-[state=active]:bg-blue-600"
                >
                  <Layers className="h-4 w-4" /> View Accounts
                </TabsTrigger>
              )}
              {showFindVoucher && (
                <TabsTrigger
                  value="find"
                  className="gap-2 rounded-xl px-4 py-2.5 font-semibold text-muted-foreground transition-colors data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md data-[state=active]:shadow-blue-600/20 dark:data-[state=active]:bg-blue-600"
                >
                  <FileSearch className="h-4 w-4" /> Find Voucher
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          {showViewAccounts && (
            <TabsContent value="view" className="space-y-4">
              {!selectedAccount ? (
                <div className="space-y-4">
                  <ZambiaCashCurrencyTransfer />
                  {/* Search — command-palette style */}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Search accounts by name or code…"
                      value={model.searchTerm}
                      onChange={(e) => model.setSearchTerm(e.target.value)}
                      className="h-12 rounded-2xl border-slate-200 bg-white/90 pl-11 pr-10 text-sm shadow-sm transition-colors focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/30 dark:border-slate-700/80 dark:bg-[#111e31] dark:focus-visible:border-blue-500"
                      data-testid="input-accounts-search"
                    />
                    {model.searchTerm && (
                      <button
                        className="absolute right-3 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-slate-800"
                        type="button"
                        aria-label="Clear account search"
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
                      onEdit={canChangeExistingRecords ? model.openEditAccountDialog : undefined}
                      displayLayout={displayLayout}
                      searchActive={!!model.searchTerm}
                      canArrange={canChangeExistingRecords && accountOrder.canArrange}
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
                    statementCustomerId={model.statementCustomerId}
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
