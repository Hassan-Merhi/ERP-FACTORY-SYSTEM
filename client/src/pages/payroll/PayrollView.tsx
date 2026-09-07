import { PageHeader } from "@/components/PageHeader";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ERPRunPayroll from "@/components/ERPRunPayroll";
import { DepositDialog } from "./DepositDialog";
import { WithdrawalDialog } from "./WithdrawalDialog";
import { BulkPaymentDialog } from "./BulkPaymentDialog";
import { WorkerDialogs } from "./WorkerDialogs";
import { BonusDialog } from "./BonusDialog";
import { EmployeeCrudDialogs } from "./EmployeeCrudDialogs";
import { BulkDialogs } from "./BulkDialogs";
import { EmployeeStatementDialog } from "./EmployeeStatementDialog";
import { EditEmployeeDialog } from "./EditEmployeeDialog";
import { EmployeesTab } from "./EmployeesTab";
import { WorkersTab } from "./WorkersTab";
import { GroupsTab } from "./GroupsTab";
import { AdvancesTab } from "./AdvancesTab";
import { WorkerDeductionDialog } from "./PayrollDialogs";
import type { usePayrollModel } from "./usePayrollModel";

export function PayrollView({ model }: { model: ReturnType<typeof usePayrollModel> }) {
  const {
    selectedCompany,
    selectedTab,
    setSelectedTab,
    empSearch,
    setEmpSearch,
    empStatusFilter,
    setEmpStatusFilter,
    depositDialogOpen,
    setDepositDialogOpen,
    bonusDialogOpen,
    setBonusDialogOpen,
    bonusTab,
    setBonusTab,
    bonusSalesPeriod,
    setBonusSalesPeriod,
    bonusSalesLocationId,
    setBonusSalesLocationId,
    bonusSalesStart,
    setBonusSalesStart,
    bonusSalesEnd,
    setBonusSalesEnd,
    bonusSalesPreview,
    setBonusSalesPreview,
    bonusSalesLoading,
    bonusSalesCustomPct,
    setBonusSalesCustomPct,
    bonusDate,
    setBonusDate,
    bonusNotes,
    setBonusNotes,
    balesRows,
    setBalesRows,
    balesPeriod,
    setBalesPeriod,
    balesStart,
    setBalesStart,
    balesEnd,
    setBalesEnd,
    withdrawalDialogOpen,
    setWithdrawalDialogOpen,
    bulkPaymentDialogOpen,
    setBulkPaymentDialogOpen,
    selectedEmployee,
    newWorkerDialogOpen,
    setNewWorkerDialogOpen,
    editWorkerDialogOpen,
    setEditWorkerDialogOpen,
    selectedWorkerForEdit,
    setSelectedWorkerForEdit,
    setWorkerOverrides,
    createEmployeeDialogOpen,
    setCreateEmployeeDialogOpen,
    deleteConflict,
    setDeleteConflict,
    deleteWorkerConflict,
    setDeleteWorkerConflict,
    statementEmployee,
    setStatementEmployee,
    statementExpanded,
    setStatementExpanded,
    editEmployeeDialogOpen,
    setEditEmployeeDialogOpen,
    setEditingEmployee,
    workerDeductionTarget,
    setWorkerDeductionTarget,
    workerDeductionAmount,
    setWorkerDeductionAmount,
    workerDeductionReason,
    setWorkerDeductionReason,
    workerDeductionDate,
    setWorkerDeductionDate,
    bulkDepositSelections,
    setBulkDepositSelections,
    bulkDepositDialogOpen,
    setBulkDepositDialogOpen,
    bulkDepositDate,
    setBulkDepositDate,
    bulkDepositNotes,
    setBulkDepositNotes,
    editBaleRates,
    setEditBaleRates,
    editBalePctRates,
    setEditBalePctRates,
    bulkBonusAutoMonth,
    setBulkBonusAutoMonth,
    bulkBonusAutoStart,
    setBulkBonusAutoStart,
    bulkBonusAutoEnd,
    setBulkBonusAutoEnd,
    bulkBonusAutoLoading,
    bulkBonusAutoPctLocationId,
    setBulkBonusAutoPctLocationId,
    bulkBonusDialogOpen,
    setBulkBonusDialogOpen,
    bulkBonusDate,
    setBulkBonusDate,
    bulkBonusNotes,
    setBulkBonusNotes,
    bulkBonusAmounts,
    setBulkBonusAmounts,
    bulkBonusBreakdowns,
    bulkBonusStep,
    setBulkBonusStep,
    pendingBonuses,
    bulkWithdrawalDialogOpen,
    setBulkWithdrawalDialogOpen,
    bulkWithdrawalDate,
    setBulkWithdrawalDate,
    bulkWithdrawalNotes,
    setBulkWithdrawalNotes,
    bulkWithdrawalAmounts,
    setBulkWithdrawalAmounts,
    bulkWithdrawalAccountType,
    setBulkWithdrawalAccountType,
    bulkWithdrawalAccountId,
    setBulkWithdrawalAccountId,
    newGroupName,
    setNewGroupName,
    newGroupDescription,
    setNewGroupDescription,
    createGroupDialogOpen,
    setCreateGroupDialogOpen,
    selectedGroupForMembers,
    groupMembersDialogOpen,
    setGroupMembersDialogOpen,
    workerGroupsExpanded,
    setWorkerGroupsExpanded,
    setCreateWorkerGroupDialogOpen,
    selectedWorkerGroupForMembers,
    setSelectedWorkerGroupForMembers,
    workerGroupMembersDialogOpen,
    setWorkerGroupMembersDialogOpen,
    setWorkerGroupMemberSelections,
    bankAccounts,
    bankAccountsLoading,
    cashAccounts,
    employeeTransactions,
    transactionsLoading,
    employeeGroups,
    locations,
    otherCompanies,
    allCompanyLocations,
    workerGroupsData,
    workerPaymentSummary,
    employeeStaff,
    workerStaff,
    workerPayments,
    ungroupedWorkers,
    selectedPayments,
    totalAmount,
    selectedPaymentsSummary,
    filteredEmployeeStaff,
    depositForm,
    withdrawalForm,
    bulkPaymentForm,
    newWorkerForm,
    editWorkerForm,
    createEmployeeForm,
    editEmployeeForm,
    cleanTxnDesc,
    depositMutation,
    withdrawalMutation,
    handleDeposit,
    handleWithdrawal,
    handleBonus,
    fetchSalesPreview,
    fetchBalesQty,
    saveBonusToPending,
    submitSmartBonus,
    handleSelectAllEmployees,
    handleToggleEmployeeDeposit,
    validSelectedEmployees,
    bulkDepositTotal,
    bulkDepositMutation,
    bulkWithdrawalMutation,
    bulkBonusMutation,
    bulkPaymentMutation,
    autoCalculateBonuses,
    handlePrintBulkBonus,
    handleDeleteEmployee,
    handleForceDeleteEmployee,
    editEmployeeMutation,
    createEmployeeMutation,
    createGroupMutation,
    groupMembers,
    addWorkerToGroupMutation,
    removeWorkerFromGroupMutation,
    handleToggleWorker,
    handleUpdateAmount,
    handleDeleteWorker,
    createWorkerMutation,
    updateWorkerMutation,
    handleForceDeleteWorker,
    deleteWorkerGroupMutation,
    addWorkerToWorkerGroupMutation,
    removeWorkerFromWorkerGroupMutation,
    workerDeductionMutation,
  } = model;
  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Payroll Management" />

      <div className="flex-1 overflow-y-auto p-4">
        <Tabs value={selectedTab} onValueChange={setSelectedTab}>
          <TabsList className="grid grid-cols-5 w-full">
            <TabsTrigger value="employees">Employees</TabsTrigger>
            <TabsTrigger value="workers">Workers</TabsTrigger>
            <TabsTrigger value="advances">Advances + Deductions</TabsTrigger>
            <TabsTrigger value="groups">Groups</TabsTrigger>
            <TabsTrigger value="run-payroll">Run Payroll</TabsTrigger>
          </TabsList>

          <TabsContent value="employees">
            <EmployeesTab
              empSearch={empSearch}
              setEmpSearch={setEmpSearch}
              empStatusFilter={empStatusFilter}
              setEmpStatusFilter={setEmpStatusFilter}
              setCreateEmployeeDialogOpen={setCreateEmployeeDialogOpen}
              employeeStaff={employeeStaff}
              filteredEmployeeStaff={filteredEmployeeStaff}
              pendingBonuses={pendingBonuses}
              setBulkDepositSelections={setBulkDepositSelections}
              setBulkDepositDialogOpen={setBulkDepositDialogOpen}
              setBulkBonusAmounts={setBulkBonusAmounts}
              setBulkBonusStep={setBulkBonusStep}
              setBulkBonusDialogOpen={setBulkBonusDialogOpen}
              setBulkWithdrawalAmounts={setBulkWithdrawalAmounts}
              setBulkWithdrawalAccountId={setBulkWithdrawalAccountId}
              setBulkWithdrawalDialogOpen={setBulkWithdrawalDialogOpen}
              setStatementEmployee={setStatementEmployee}
              handleDeposit={handleDeposit}
              handleBonus={handleBonus}
              handleWithdrawal={handleWithdrawal}
              setEditingEmployee={setEditingEmployee}
              setEditEmployeeDialogOpen={setEditEmployeeDialogOpen}
              handleDeleteEmployee={handleDeleteEmployee}
            />
          </TabsContent>

          <TabsContent value="workers">
            <WorkersTab
              workerStaff={workerStaff}
              workerPaymentSummary={workerPaymentSummary}
              selectedPayments={selectedPayments}
              totalAmount={totalAmount}
              workerGroups={workerGroupsData}
              workerGroupsExpanded={workerGroupsExpanded}
              setWorkerGroupsExpanded={setWorkerGroupsExpanded}
              workerPayments={workerPayments}
              setWorkerOverrides={setWorkerOverrides}
              setBulkPaymentDialogOpen={setBulkPaymentDialogOpen}
              setNewWorkerDialogOpen={setNewWorkerDialogOpen}
              setWorkerDeductionTarget={setWorkerDeductionTarget}
              setSelectedWorkerForEdit={setSelectedWorkerForEdit}
              setEditWorkerDialogOpen={setEditWorkerDialogOpen}
              setCreateWorkerGroupDialogOpen={setCreateWorkerGroupDialogOpen}
              setSelectedWorkerGroupForMembers={setSelectedWorkerGroupForMembers}
              setWorkerGroupMembersDialogOpen={setWorkerGroupMembersDialogOpen}
              setWorkerGroupMemberSelections={setWorkerGroupMemberSelections}
              deleteWorkerGroupMutation={deleteWorkerGroupMutation}
              handleToggleWorker={handleToggleWorker}
              handleUpdateAmount={handleUpdateAmount}
              handleDeleteWorker={handleDeleteWorker}
              setStatementEmployee={setStatementEmployee}
              ungroupedWorkers={ungroupedWorkers}
              addWorkerToWorkerGroupMutation={addWorkerToWorkerGroupMutation}
            />
          </TabsContent>

          <TabsContent value="advances">
            <AdvancesTab cashAccounts={cashAccounts} />
          </TabsContent>

          <TabsContent value="groups">
            <GroupsTab />
          </TabsContent>

          <TabsContent value="run-payroll">
            <ERPRunPayroll />
          </TabsContent>
        </Tabs>

        {/* Dialogs */}
        <BulkDialogs
          bulkDepositDialogOpen={bulkDepositDialogOpen}
          setBulkDepositDialogOpen={setBulkDepositDialogOpen}
          bulkDepositDate={bulkDepositDate}
          setBulkDepositDate={setBulkDepositDate}
          bulkDepositNotes={bulkDepositNotes}
          setBulkDepositNotes={setBulkDepositNotes}
          employeeStaff={employeeStaff}
          bulkDepositSelections={bulkDepositSelections}
          handleSelectAllEmployees={handleSelectAllEmployees}
          handleToggleEmployeeDeposit={handleToggleEmployeeDeposit}
          bulkDepositTotal={bulkDepositTotal}
          validSelectedEmployees={validSelectedEmployees}
          bulkDepositMutation={bulkDepositMutation}
          bulkWithdrawalDialogOpen={bulkWithdrawalDialogOpen}
          setBulkWithdrawalDialogOpen={setBulkWithdrawalDialogOpen}
          bulkWithdrawalDate={bulkWithdrawalDate}
          setBulkWithdrawalDate={setBulkWithdrawalDate}
          bulkWithdrawalAccountType={bulkWithdrawalAccountType}
          setBulkWithdrawalAccountType={setBulkWithdrawalAccountType}
          bulkWithdrawalAccountId={bulkWithdrawalAccountId}
          setBulkWithdrawalAccountId={setBulkWithdrawalAccountId}
          bulkWithdrawalNotes={bulkWithdrawalNotes}
          setBulkWithdrawalNotes={setBulkWithdrawalNotes}
          bulkWithdrawalAmounts={bulkWithdrawalAmounts}
          setBulkWithdrawalAmounts={setBulkWithdrawalAmounts}
          bulkWithdrawalMutation={bulkWithdrawalMutation}
          cashAccounts={cashAccounts}
          bankAccounts={bankAccounts}
          bulkBonusDialogOpen={bulkBonusDialogOpen}
          setBulkBonusDialogOpen={setBulkBonusDialogOpen}
          bulkBonusStep={bulkBonusStep}
          setBulkBonusStep={setBulkBonusStep}
          bulkBonusDate={bulkBonusDate}
          setBulkBonusDate={setBulkBonusDate}
          bulkBonusNotes={bulkBonusNotes}
          setBulkBonusNotes={setBulkBonusNotes}
          bulkBonusAutoMonth={bulkBonusAutoMonth}
          setBulkBonusAutoMonth={setBulkBonusAutoMonth}
          bulkBonusAutoStart={bulkBonusAutoStart}
          setBulkBonusAutoStart={setBulkBonusAutoStart}
          bulkBonusAutoEnd={bulkBonusAutoEnd}
          setBulkBonusAutoEnd={setBulkBonusAutoEnd}
          autoCalculateBonuses={autoCalculateBonuses}
          bulkBonusAutoLoading={bulkBonusAutoLoading}
          bulkBonusAutoPctLocationId={bulkBonusAutoPctLocationId}
          setBulkBonusAutoPctLocationId={setBulkBonusAutoPctLocationId}
          bulkBonusAmounts={bulkBonusAmounts}
          setBulkBonusAmounts={setBulkBonusAmounts}
          pendingBonuses={pendingBonuses}
          bulkBonusBreakdowns={bulkBonusBreakdowns}
          bulkBonusMutation={bulkBonusMutation}
          handlePrintBulkBonus={handlePrintBulkBonus}
          locations={locations}
          allCompanyLocations={allCompanyLocations}
        />

        <DepositDialog
          open={depositDialogOpen}
          onOpenChange={setDepositDialogOpen}
          selectedEmployee={selectedEmployee}
          form={depositForm}
          mutation={depositMutation}
        />

        <WithdrawalDialog
          open={withdrawalDialogOpen}
          onOpenChange={setWithdrawalDialogOpen}
          selectedEmployee={selectedEmployee}
          form={withdrawalForm}
          mutation={withdrawalMutation}
          cashAccounts={cashAccounts}
          bankAccounts={bankAccounts}
          bankAccountsLoading={bankAccountsLoading}
        />

        <BonusDialog
          open={bonusDialogOpen}
          onOpenChange={setBonusDialogOpen}
          selectedEmployee={selectedEmployee}
          bonusTab={bonusTab}
          setBonusTab={setBonusTab}
          bonusSalesPreview={bonusSalesPreview}
          setBonusSalesPreview={setBonusSalesPreview}
          bonusSalesCustomPct={bonusSalesCustomPct}
          setBonusSalesCustomPct={setBonusSalesCustomPct}
          bonusSalesLocationId={bonusSalesLocationId}
          setBonusSalesLocationId={setBonusSalesLocationId}
          bonusSalesPeriod={bonusSalesPeriod}
          setBonusSalesPeriod={setBonusSalesPeriod}
          bonusSalesStart={bonusSalesStart}
          setBonusSalesStart={setBonusSalesStart}
          bonusSalesEnd={bonusSalesEnd}
          setBonusSalesEnd={setBonusSalesEnd}
          bonusSalesLoading={bonusSalesLoading}
          fetchSalesPreview={fetchSalesPreview}
          balesRows={balesRows}
          setBalesRows={setBalesRows}
          balesPeriod={balesPeriod}
          setBalesPeriod={setBalesPeriod}
          balesStart={balesStart}
          setBalesStart={setBalesStart}
          balesEnd={balesEnd}
          setBalesEnd={setBalesEnd}
          fetchBalesQty={fetchBalesQty}
          bonusDate={bonusDate}
          setBonusDate={setBonusDate}
          bonusNotes={bonusNotes}
          setBonusNotes={setBonusNotes}
          saveBonusToPending={saveBonusToPending}
          submitSmartBonus={submitSmartBonus}
          locations={locations}
          allCompanyLocations={allCompanyLocations}
        />

        <EmployeeStatementDialog
          statementEmployee={statementEmployee}
          setStatementEmployee={setStatementEmployee}
          transactionsLoading={transactionsLoading}
          employeeTransactions={employeeTransactions}
          statementExpanded={statementExpanded}
          setStatementExpanded={setStatementExpanded}
          cleanTxnDesc={cleanTxnDesc}
        />

        <WorkerDeductionDialog
          target={workerDeductionTarget}
          onClose={() => setWorkerDeductionTarget(null)}
          amount={workerDeductionAmount}
          setAmount={setWorkerDeductionAmount}
          reason={workerDeductionReason}
          setReason={setWorkerDeductionReason}
          date={workerDeductionDate}
          setDate={setWorkerDeductionDate}
          mutation={workerDeductionMutation}
        />

        <BulkPaymentDialog
          open={bulkPaymentDialogOpen}
          onOpenChange={setBulkPaymentDialogOpen}
          selectedPayments={selectedPaymentsSummary}
          totalAmount={totalAmount}
          workerStaff={workerStaff}
          form={bulkPaymentForm}
          mutation={bulkPaymentMutation}
          cashAccounts={cashAccounts}
          bankAccounts={bankAccounts}
          bankAccountsLoading={bankAccountsLoading}
        />

        <WorkerDialogs
          newWorkerDialogOpen={newWorkerDialogOpen}
          setNewWorkerDialogOpen={setNewWorkerDialogOpen}
          newWorkerForm={newWorkerForm}
          createWorkerMutation={createWorkerMutation}
          editWorkerDialogOpen={editWorkerDialogOpen}
          setEditWorkerDialogOpen={setEditWorkerDialogOpen}
          selectedWorkerForEdit={selectedWorkerForEdit}
          editWorkerForm={editWorkerForm}
          updateWorkerMutation={updateWorkerMutation}
          deleteWorkerConflict={deleteWorkerConflict}
          setDeleteWorkerConflict={setDeleteWorkerConflict}
          handleForceDeleteWorker={handleForceDeleteWorker}
          workerGroupMembersDialogOpen={workerGroupMembersDialogOpen}
          setWorkerGroupMembersDialogOpen={setWorkerGroupMembersDialogOpen}
          selectedWorkerGroupForMembers={selectedWorkerGroupForMembers}
          allWorkerGroups={workerGroupsData}
          allWorkers={workerStaff}
          addWorkerToWorkerGroupMutation={addWorkerToWorkerGroupMutation}
          removeWorkerFromWorkerGroupMutation={removeWorkerFromWorkerGroupMutation}
        />

        <EditEmployeeDialog
          open={editEmployeeDialogOpen}
          onOpenChange={setEditEmployeeDialogOpen}
          setEditingEmployee={setEditingEmployee}
          editEmployeeForm={editEmployeeForm}
          editEmployeeMutation={editEmployeeMutation}
          employeeGroups={employeeGroups}
          otherCompanies={otherCompanies}
          selectedCompany={selectedCompany}
          locations={locations}
          allCompanyLocations={allCompanyLocations}
          editBaleRates={editBaleRates}
          setEditBaleRates={setEditBaleRates}
          editBalePctRates={editBalePctRates}
          setEditBalePctRates={setEditBalePctRates}
          pctLocations={allCompanyLocations}
        />

        <EmployeeCrudDialogs
          createEmployeeDialogOpen={createEmployeeDialogOpen}
          setCreateEmployeeDialogOpen={setCreateEmployeeDialogOpen}
          createEmployeeForm={createEmployeeForm}
          createEmployeeMutation={createEmployeeMutation}
          employeeGroups={employeeGroups}
          deleteConflict={deleteConflict}
          setDeleteConflict={setDeleteConflict}
          handleForceDeleteEmployee={handleForceDeleteEmployee}
          createGroupDialogOpen={createGroupDialogOpen}
          setCreateGroupDialogOpen={setCreateGroupDialogOpen}
          newGroupName={newGroupName}
          setNewGroupName={setNewGroupName}
          newGroupDescription={newGroupDescription}
          setNewGroupDescription={setNewGroupDescription}
          createGroupMutation={createGroupMutation}
          groupMembersDialogOpen={groupMembersDialogOpen}
          setGroupMembersDialogOpen={setGroupMembersDialogOpen}
          selectedGroupForMembers={selectedGroupForMembers}
          employeeStaff={employeeStaff}
          groupMembers={groupMembers}
          addWorkerToGroupMutation={addWorkerToGroupMutation}
          removeWorkerFromGroupMutation={removeWorkerFromGroupMutation}
        />
      </div>
    </div>
  );
}
