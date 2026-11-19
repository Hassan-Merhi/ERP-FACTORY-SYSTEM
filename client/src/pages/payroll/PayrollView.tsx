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
import { AdvancesTab } from "./AdvancesTab";
import { WorkerDeductionDialog } from "./PayrollDialogs";
import type { usePayrollModel } from "./usePayrollModel";
import { isPayrollSection, usePayrollSection } from "./payrollTabs";

export function PayrollView({ model }: { model: ReturnType<typeof usePayrollModel> }) {
  const [selectedTab, setSelectedTab] = usePayrollSection();

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <PageHeader title="Payroll Management" />

      <div className="flex-1 overflow-y-auto p-4">
        <Tabs value={selectedTab} onValueChange={(value) => isPayrollSection(value) && setSelectedTab(value)}>
          {/* Phones scroll the tab row instead of squeezing four labels into equal columns. */}
          <div className="erp-mobile-scroll-tabs pb-1">
            <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Payroll sections">
              <TabsTrigger value="employees">Employees</TabsTrigger>
              <TabsTrigger value="workers">Workers</TabsTrigger>
              <TabsTrigger value="advances">Advances + Deductions</TabsTrigger>
              <TabsTrigger value="run-payroll">Run Payroll</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="employees">
            <EmployeesTab
              empSearch={model.empSearch}
              setEmpSearch={model.setEmpSearch}
              empStatusFilter={model.empStatusFilter}
              setEmpStatusFilter={model.setEmpStatusFilter}
              setCreateEmployeeDialogOpen={model.setCreateEmployeeDialogOpen}
              employeeStaff={model.employeeStaff}
              filteredEmployeeStaff={model.filteredEmployeeStaff}
              employeeGroups={model.employeeGroups}
              setCreateGroupDialogOpen={model.setCreateGroupDialogOpen}
              setSelectedGroupForMembers={model.setSelectedGroupForMembers}
              setGroupMembersDialogOpen={model.setGroupMembersDialogOpen}
              pendingBonuses={model.pendingBonuses}
              setBulkDepositSelections={model.setBulkDepositSelections}
              setBulkDepositAmounts={model.setBulkDepositAmounts}
              setBulkDepositDialogOpen={model.setBulkDepositDialogOpen}
              setBulkBonusAmounts={model.setBulkBonusAmounts}
              setBulkBonusStep={model.setBulkBonusStep}
              setBulkBonusDialogOpen={model.setBulkBonusDialogOpen}
              setBulkWithdrawalAmounts={model.setBulkWithdrawalAmounts}
              setBulkWithdrawalAccountId={model.setBulkWithdrawalAccountId}
              setBulkWithdrawalDialogOpen={model.setBulkWithdrawalDialogOpen}
              setStatementEmployee={model.setStatementEmployee}
              handleDeposit={model.handleDeposit}
              handleBonus={model.handleBonus}
              handleWithdrawal={model.handleWithdrawal}
              setEditingEmployee={model.setEditingEmployee}
              setEditEmployeeDialogOpen={model.setEditEmployeeDialogOpen}
              handleDeleteEmployee={model.handleDeleteEmployee}
              canChangeExistingRecords={model.canChangeExistingRecords}
              canCreate={model.canCreate}
            />
          </TabsContent>

          <TabsContent value="workers">
            <WorkersTab
              workerStaff={model.workerStaff}
              workerPaymentSummary={model.workerPaymentSummary}
              selectedPayments={model.selectedPayments}
              totalAmount={model.totalAmount}
              workerGroups={model.workerGroupsData}
              workerGroupsExpanded={model.workerGroupsExpanded}
              setWorkerGroupsExpanded={model.setWorkerGroupsExpanded}
              workerPayments={model.workerPayments}
              setWorkerOverrides={model.setWorkerOverrides}
              setBulkPaymentDialogOpen={model.setBulkPaymentDialogOpen}
              setNewWorkerDialogOpen={model.setNewWorkerDialogOpen}
              setWorkerDeductionTarget={model.setWorkerDeductionTarget}
              setSelectedWorkerForEdit={model.setSelectedWorkerForEdit}
              setEditWorkerDialogOpen={model.setEditWorkerDialogOpen}
              setCreateWorkerGroupDialogOpen={model.setCreateWorkerGroupDialogOpen}
              setSelectedWorkerGroupForMembers={model.setSelectedWorkerGroupForMembers}
              setWorkerGroupMembersDialogOpen={model.setWorkerGroupMembersDialogOpen}
              setWorkerGroupMemberSelections={model.setWorkerGroupMemberSelections}
              deleteWorkerGroupMutation={model.deleteWorkerGroupMutation}
              handleToggleWorker={model.handleToggleWorker}
              handleUpdateAmount={model.handleUpdateAmount}
              handleDeleteWorker={model.handleDeleteWorker}
              setStatementEmployee={model.setStatementEmployee}
              ungroupedWorkers={model.ungroupedWorkers}
              addWorkerToWorkerGroupMutation={model.addWorkerToWorkerGroupMutation}
              canChangeExistingRecords={model.canChangeExistingRecords}
              canCreate={model.canCreate}
            />
          </TabsContent>

          <TabsContent value="advances">
            <AdvancesTab cashAccounts={model.cashAccounts} />
          </TabsContent>

          <TabsContent value="run-payroll">
            <ERPRunPayroll />
          </TabsContent>
        </Tabs>

        {/* Dialogs */}
        <BulkDialogs
          bulkDepositDialogOpen={model.bulkDepositDialogOpen}
          setBulkDepositDialogOpen={model.setBulkDepositDialogOpen}
          bulkDepositDate={model.bulkDepositDate}
          setBulkDepositDate={model.setBulkDepositDate}
          bulkDepositNotes={model.bulkDepositNotes}
          setBulkDepositNotes={model.setBulkDepositNotes}
          employeeStaff={model.employeeStaff}
          bulkDepositSelections={model.bulkDepositSelections}
          bulkDepositAmounts={model.bulkDepositAmounts}
          setBulkDepositAmounts={model.setBulkDepositAmounts}
          handleSelectAllEmployees={model.handleSelectAllEmployees}
          handleToggleEmployeeDeposit={model.handleToggleEmployeeDeposit}
          bulkDepositTotal={model.bulkDepositTotal}
          validSelectedEmployees={model.validSelectedEmployees}
          bulkDepositMutation={model.bulkDepositMutation}
          bulkWithdrawalDialogOpen={model.bulkWithdrawalDialogOpen}
          setBulkWithdrawalDialogOpen={model.setBulkWithdrawalDialogOpen}
          bulkWithdrawalDate={model.bulkWithdrawalDate}
          setBulkWithdrawalDate={model.setBulkWithdrawalDate}
          bulkWithdrawalAccountType={model.bulkWithdrawalAccountType}
          setBulkWithdrawalAccountType={model.setBulkWithdrawalAccountType}
          bulkWithdrawalAccountId={model.bulkWithdrawalAccountId}
          setBulkWithdrawalAccountId={model.setBulkWithdrawalAccountId}
          bulkWithdrawalNotes={model.bulkWithdrawalNotes}
          setBulkWithdrawalNotes={model.setBulkWithdrawalNotes}
          bulkWithdrawalAmounts={model.bulkWithdrawalAmounts}
          setBulkWithdrawalAmounts={model.setBulkWithdrawalAmounts}
          bulkWithdrawalMutation={model.bulkWithdrawalMutation}
          cashAccounts={model.cashAccounts}
          bankAccounts={model.bankAccounts}
          bulkBonusDialogOpen={model.bulkBonusDialogOpen}
          setBulkBonusDialogOpen={model.setBulkBonusDialogOpen}
          bulkBonusStep={model.bulkBonusStep}
          setBulkBonusStep={model.setBulkBonusStep}
          bulkBonusDate={model.bulkBonusDate}
          setBulkBonusDate={model.setBulkBonusDate}
          bulkBonusNotes={model.bulkBonusNotes}
          setBulkBonusNotes={model.setBulkBonusNotes}
          bulkBonusAutoMonth={model.bulkBonusAutoMonth}
          setBulkBonusAutoMonth={model.setBulkBonusAutoMonth}
          bulkBonusAutoStart={model.bulkBonusAutoStart}
          setBulkBonusAutoStart={model.setBulkBonusAutoStart}
          bulkBonusAutoEnd={model.bulkBonusAutoEnd}
          setBulkBonusAutoEnd={model.setBulkBonusAutoEnd}
          autoCalculateBonuses={model.autoCalculateBonuses}
          bulkBonusAutoLoading={model.bulkBonusAutoLoading}
          bulkBonusAutoPctLocationId={model.bulkBonusAutoPctLocationId}
          setBulkBonusAutoPctLocationId={model.setBulkBonusAutoPctLocationId}
          bulkBonusAmounts={model.bulkBonusAmounts}
          setBulkBonusAmounts={model.setBulkBonusAmounts}
          pendingBonuses={model.pendingBonuses}
          bulkBonusBreakdowns={model.bulkBonusBreakdowns}
          bulkBonusMutation={model.bulkBonusMutation}
          handlePrintBulkBonus={model.handlePrintBulkBonus}
          locations={model.locations}
          allCompanyLocations={model.allCompanyLocations}
        />

        <DepositDialog
          open={model.depositDialogOpen}
          onOpenChange={model.setDepositDialogOpen}
          selectedEmployee={model.selectedEmployee}
          form={model.depositForm}
          mutation={model.depositMutation}
        />

        <WithdrawalDialog
          open={model.withdrawalDialogOpen}
          onOpenChange={model.setWithdrawalDialogOpen}
          selectedEmployee={model.selectedEmployee}
          form={model.withdrawalForm}
          mutation={model.withdrawalMutation}
          cashAccounts={model.cashAccounts}
          bankAccounts={model.bankAccounts}
          bankAccountsLoading={model.bankAccountsLoading}
        />

        <BonusDialog
          open={model.bonusDialogOpen}
          onOpenChange={model.setBonusDialogOpen}
          selectedEmployee={model.selectedEmployee}
          bonusTab={model.bonusTab}
          setBonusTab={model.setBonusTab}
          bonusSalesPreview={model.bonusSalesPreview}
          setBonusSalesPreview={model.setBonusSalesPreview}
          bonusSalesCustomPct={model.bonusSalesCustomPct}
          setBonusSalesCustomPct={model.setBonusSalesCustomPct}
          bonusSalesLocationId={model.bonusSalesLocationId}
          setBonusSalesLocationId={model.setBonusSalesLocationId}
          bonusSalesPeriod={model.bonusSalesPeriod}
          setBonusSalesPeriod={model.setBonusSalesPeriod}
          bonusSalesStart={model.bonusSalesStart}
          setBonusSalesStart={model.setBonusSalesStart}
          bonusSalesEnd={model.bonusSalesEnd}
          setBonusSalesEnd={model.setBonusSalesEnd}
          bonusSalesLoading={model.bonusSalesLoading}
          fetchSalesPreview={model.fetchSalesPreview}
          balesRows={model.balesRows}
          setBalesRows={model.setBalesRows}
          balesPeriod={model.balesPeriod}
          setBalesPeriod={model.setBalesPeriod}
          balesStart={model.balesStart}
          setBalesStart={model.setBalesStart}
          balesEnd={model.balesEnd}
          setBalesEnd={model.setBalesEnd}
          fetchBalesQty={model.fetchBalesQty}
          bonusDate={model.bonusDate}
          setBonusDate={model.setBonusDate}
          bonusNotes={model.bonusNotes}
          setBonusNotes={model.setBonusNotes}
          saveBonusToPending={model.saveBonusToPending}
          submitSmartBonus={model.submitSmartBonus}
          locations={model.locations}
          allCompanyLocations={model.allCompanyLocations}
        />

        <EmployeeStatementDialog
          statementEmployee={model.statementEmployee}
          setStatementEmployee={model.setStatementEmployee}
          transactionsLoading={model.transactionsLoading}
          employeeTransactions={model.employeeTransactions}
          statementExpanded={model.statementExpanded}
          setStatementExpanded={model.setStatementExpanded}
          cleanTxnDesc={model.cleanTxnDesc}
        />

        <WorkerDeductionDialog
          target={model.workerDeductionTarget}
          onClose={() => model.setWorkerDeductionTarget(null)}
          amount={model.workerDeductionAmount}
          setAmount={model.setWorkerDeductionAmount}
          reason={model.workerDeductionReason}
          setReason={model.setWorkerDeductionReason}
          date={model.workerDeductionDate}
          setDate={model.setWorkerDeductionDate}
          mutation={model.workerDeductionMutation}
        />

        <BulkPaymentDialog
          open={model.bulkPaymentDialogOpen}
          onOpenChange={model.setBulkPaymentDialogOpen}
          selectedPayments={model.selectedPaymentsSummary}
          totalAmount={model.totalAmount}
          workerStaff={model.workerStaff}
          form={model.bulkPaymentForm}
          mutation={model.bulkPaymentMutation}
          cashAccounts={model.cashAccounts}
          bankAccounts={model.bankAccounts}
          bankAccountsLoading={model.bankAccountsLoading}
        />

        <WorkerDialogs
          newWorkerDialogOpen={model.newWorkerDialogOpen}
          setNewWorkerDialogOpen={model.setNewWorkerDialogOpen}
          newWorkerForm={model.newWorkerForm}
          createWorkerMutation={model.createWorkerMutation}
          editWorkerDialogOpen={model.editWorkerDialogOpen}
          setEditWorkerDialogOpen={model.setEditWorkerDialogOpen}
          selectedWorkerForEdit={model.selectedWorkerForEdit}
          editWorkerForm={model.editWorkerForm}
          updateWorkerMutation={model.updateWorkerMutation}
          deleteWorkerConflict={model.deleteWorkerConflict}
          setDeleteWorkerConflict={model.setDeleteWorkerConflict}
          handleForceDeleteWorker={model.handleForceDeleteWorker}
          createWorkerGroupDialogOpen={model.createWorkerGroupDialogOpen}
          setCreateWorkerGroupDialogOpen={model.setCreateWorkerGroupDialogOpen}
          workerGroupMembersDialogOpen={model.workerGroupMembersDialogOpen}
          setWorkerGroupMembersDialogOpen={model.setWorkerGroupMembersDialogOpen}
          selectedWorkerGroupForMembers={model.selectedWorkerGroupForMembers}
          allWorkerGroups={model.workerGroupsData}
          allWorkers={model.workerStaff}
          addWorkerToWorkerGroupMutation={model.addWorkerToWorkerGroupMutation}
          removeWorkerFromWorkerGroupMutation={model.removeWorkerFromWorkerGroupMutation}
        />

        <EditEmployeeDialog
          open={model.editEmployeeDialogOpen}
          onOpenChange={model.setEditEmployeeDialogOpen}
          setEditingEmployee={model.setEditingEmployee}
          editEmployeeForm={model.editEmployeeForm}
          editEmployeeMutation={model.editEmployeeMutation}
          employeeGroups={model.employeeGroups}
          otherCompanies={model.otherCompanies}
          selectedCompany={model.selectedCompany}
          locations={model.locations}
          allCompanyLocations={model.allCompanyLocations}
          editBaleRates={model.editBaleRates}
          setEditBaleRates={model.setEditBaleRates}
          editBalePctRates={model.editBalePctRates}
          setEditBalePctRates={model.setEditBalePctRates}
          pctLocations={model.allCompanyLocations}
        />

        <EmployeeCrudDialogs
          createEmployeeDialogOpen={model.createEmployeeDialogOpen}
          setCreateEmployeeDialogOpen={model.setCreateEmployeeDialogOpen}
          createEmployeeForm={model.createEmployeeForm}
          createEmployeeMutation={model.createEmployeeMutation}
          employeeGroups={model.employeeGroups}
          deleteConflict={model.deleteConflict}
          setDeleteConflict={model.setDeleteConflict}
          handleForceDeleteEmployee={model.handleForceDeleteEmployee}
          createGroupDialogOpen={model.createGroupDialogOpen}
          setCreateGroupDialogOpen={model.setCreateGroupDialogOpen}
          newGroupName={model.newGroupName}
          setNewGroupName={model.setNewGroupName}
          newGroupDescription={model.newGroupDescription}
          setNewGroupDescription={model.setNewGroupDescription}
          createGroupMutation={model.createGroupMutation}
          groupMembersDialogOpen={model.groupMembersDialogOpen}
          setGroupMembersDialogOpen={model.setGroupMembersDialogOpen}
          selectedGroupForMembers={model.selectedGroupForMembers}
          employeeStaff={model.employeeStaff}
          groupMembers={model.groupMembers}
          addWorkerToGroupMutation={model.addWorkerToGroupMutation}
          removeWorkerFromGroupMutation={model.removeWorkerFromGroupMutation}
        />
      </div>
    </div>
  );
}
