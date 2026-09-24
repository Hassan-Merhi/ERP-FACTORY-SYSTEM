import type { ApplicationLanguage } from "@shared/applicationLanguageContract";

export const applicationEnglishTranslations = {
  "language.label": "Language",
  "language.english": "English",
  "language.arabic": "Arabic",
  "language.french": "French",
  "language.saving": "Saving language…",
  "language.saveFailed": "The language changed on this device, but the account preference could not be saved.",
  "language.changed": "Application language changed to English.",
  "accessibility.skipToMainContent": "Skip to main content",
  "accessibility.openSearch": "Open search",
  "accessibility.openWorkspaceControls": "Open account and display controls",
  "accessibility.toggleSidebar": "Toggle Sidebar",
  "accessibility.sidebar": "Sidebar",
  "accessibility.sidebarDescription": "Displays the mobile sidebar.",
  "accessibility.closeDialog": "Close dialog",
  "accessibility.closePanel": "Close panel",
  "workspace.controls": "Workspace controls",
  "workspace.controlsDescription": "Account, display, synchronization, language, and search controls.",
  "workspace.search": "Search the workspace",
  "workspace.myNotes": "My notes",
  "workspace.statusDisplay": "Status and display",
  "workspace.pendingSync": "Pending synchronization",
  "workspace.theme": "Theme",
  "workspace.accountLanguage": "Account and language",
  "workspace.notifications": "Notifications",
  "mobileNav.ariaLabel": "Primary ERP navigation",
  "mobileNav.tracking": "Tracking",
  "mobileNav.inventory": "Inventory",
  "mobileNav.sales": "Sales",
  "mobileNav.accounts": "Accounts",
  "mobileNav.more": "More",
  "mobileFilters.open": "Filters",
  "mobileFilters.clear": "Clear filters",
  "mobileFilters.apply": "Apply",
  "mobileFilters.liveHint": "Filter changes apply to the results immediately.",
  "mobileFilters.search": "Search",
  "mobileFilters.clearSearch": "Clear search",
  "company.loadingSelector": "Loading company selector",
  "company.current": "Current company",
  "company.openSwitcher": "Open company switcher",
  "user.menu": "Account menu",
  "common.logout": "Log out",
  "common.refresh": "Refresh",
  "access.noTabsAvailable": "No tabs are available for this user.",
  "common.updateAvailable": "Update available",
  "common.updateDescription": "A new version of the app is ready.",
  "containerVerification.itemsRefreshed": "Container items refreshed",
  "containerVerification.latestDetailsLoaded":
    "${data.imported} current item lines loaded from the latest container details${skippedMsg}",
  "containerVerification.refreshNeedsConnection": "Refresh requires a connection",
  "factoryAdvances.netDue": "Net Due",
  "accountMigration.returnFailed": "Account return migration failed",
  "settings.dataTools.costOverride.title": "Location Cost Price Override",
  "settings.dataTools.costOverride.description":
    "Directly replace the average cost for existing inventory at one location. Developer use only; no voucher or daybook entry is created.",
  "settings.dataTools.costOverride.selectLocation": "Select Location",
  "settings.dataTools.costOverride.chooseLocation": "Choose location...",
  "settings.dataTools.costOverride.openButton": "Update Location Costs from Excel",
  "settings.dataTools.costOverride.dialogDescription":
    "Upload an Excel file with barcode and costPrice columns. This directly overwrites the selected location's current average rate and total value.",
  "settings.dataTools.costOverride.success": "Location cost prices were updated successfully.",
  "settings.dataTools.costOverride.close": "Close",
  "settings.dataTools.costOverride.warning":
    "This is a direct valuation correction. It does not create accounting entries and should not be used for normal stock receipts or production.",
  "settings.dataTools.costOverride.downloadTemplate": "Download Template",
  "settings.dataTools.costOverride.excelFile": "Excel File",
  "settings.dataTools.costOverride.fileHint":
    "Each row must contain a matching item barcode and a costPrice greater than 0.",
  "settings.dataTools.costOverride.barcode": "Barcode",
  "settings.dataTools.costOverride.newCost": "New Cost",
  "settings.dataTools.costOverride.updatesReady": "cost updates ready",
  "settings.dataTools.costOverride.cancel": "Cancel",
  "settings.dataTools.costOverride.updating": "Updating…",
  "settings.dataTools.costOverride.apply": "Apply Cost Updates",
  "settings.dataTools.costOverride.templateDownloaded": "Template Downloaded",
  "settings.dataTools.costOverride.templateDownloadedDescription": "Use this template to update cost prices.",
  "settings.dataTools.costOverride.emptyFile": "Empty File",
  "settings.dataTools.costOverride.emptyFileDescription": "The Excel file is empty.",
  "settings.dataTools.costOverride.missingColumns": "Missing Required Columns",
  "settings.dataTools.costOverride.missingColumnsDescription":
    "Expected barcode and costPrice columns. Download the template for the required format.",
  "settings.dataTools.costOverride.row": "Row",
  "settings.dataTools.costOverride.barcodeRequired": "Barcode is required",
  "settings.dataTools.costOverride.costPositive": "Cost price must be greater than 0",
  "settings.dataTools.costOverride.readError": "Error Reading File",
  "settings.dataTools.costOverride.readErrorDescription": "Please ensure the file is a valid Excel file.",
  "settings.dataTools.costOverride.noLocation": "No Location Selected",
  "settings.dataTools.costOverride.noLocationDescription": "Please select a location first.",
  "settings.dataTools.costOverride.cannotImport": "Cannot Import",
  "settings.dataTools.costOverride.fixErrors": "Please fix validation errors first.",
  "settings.dataTools.costOverride.importSuccessful": "Import Successful",
  "settings.dataTools.costOverride.updatedPrefix": "Updated cost prices:",
  "settings.dataTools.costOverride.importFailed": "Import Failed",
  "settings.dataTools.costOverride.importFailedDescription": "Failed to import cost prices.",
  "common.search": "Search...",
  "common.filter": "Filter",
  "common.actions": "Actions",
  "common.export": "Export",
  "common.today": "Today",
  "common.yesterday": "Yesterday",
  "common.allTime": "All Time",
  "common.thisWeek": "This Week",
  "common.thisMonth": "This Month",
  "common.lastMonth": "Last 1 Month",
  "common.lastSixMonths": "Last 6 Months",
  "common.thisYear": "This Year",
  "common.customRange": "Custom Range...",
  "common.allTypes": "All Types",
  "common.allEntries": "All Entries",
  "common.active": "Active",
  "common.inactive": "Inactive",
  "common.total": "Total",
  "common.status": "Status",
  "common.count": "Count",
  "common.dateType": "DATE / TYPE",
  "factory.overview": "Overview",
  "factory.overviewDescription": "Manufacturing overview — output metrics & bale lifecycle",
  "factory.otwTracking": "OTW Tracking",
  "factory.production": "Production",
  "factory.comparison": "Comparison",
  "factory.baleLedger": "Bale Ledger",
  "factory.shippingContainers": "Shipping Containers",
  "factory.byGrade": "BY GRADE",
  "factory.productionValue": "PRODUCTION VALUE",
  "factory.batchCost": "BATCH COST",
  "factory.productions": "Productions",
  "factory.originalBatches": "Original Batches",
  "factory.payrollOverview": "PAYROLL OVERVIEW",
  "factory.workersTransport": "WORKERS + TRANSPORT",
  "factory.workerRemaining": "WORKER REMAINING",
  "factory.totalPayroll": "TOTAL PAYROLL",
  "factory.employeeExpected": "EMPLOYEE EXPECTED",
  "factory.stockEntry.baleLimitReached": "2-item limit reached",
  "factory.stockEntry.finishBeforeAdding": "Finish this Stock Entry before adding another item.",
  "factory.stockEntry.baleLimitConfirmFirst":
    "A Stock Entry can contain at most 2 different items. Increase bale quantity on an existing item or confirm this entry before adding another item.",
  "factory.stockEntry.baleLimit": "A Stock Entry can contain at most 2 different items.",
  "factory.stockEntry.baleLimitReduceQuantity":
    "A Stock Entry can contain at most 2 different items. Remove an item before confirming.",
  "daybook.transactions": "Transactions",
  "daybook.editsActivity": "Edits & Activity",
  "daybook.allFactoryTransactions": "All factory transactions in one view",
  "settings.usersPermissions": "Users & Permissions",
  "settings.manageUsersRoles": "Manage users and role assignments.",
  "settings.userManagement": "User Management",
  "settings.selectUser": "Select a user to manage their account, access, and permissions.",
  "settings.addUser": "Add User",
  "settings.fullAccess": "Full access",
  "factory.permissions.productionTargets": "Production Targets",
  "factory.permissions.productComparison": "Product Comparison",
  "factory.permissions.movements": "Movements",
  "payroll.title": "Payroll & Benefits",
  "payroll.description": "Workers, employees and insurance management",
  "payroll.workers": "Workers",
  "payroll.employees": "Employees",
  "payroll.insurance": "Insurance",
  "payroll.categories": "Categories",
  "payroll.totalSalary": "Total Salary",
  "payroll.transport": "Transport",
  "payroll.advances": "Advances",
  "payroll.dueToday": "Due Today",
  "payroll.totalRemaining": "Total Remaining",
  "payroll.searchPlaceholder": "Search by name, code, position, nationality...",
  "payroll.addWorker": "Add Worker",
  "payroll.worker": "WORKER",
  "payroll.position": "POSITION",
  "payroll.nationality": "NATIONALITY",
  "payroll.location": "LOCATION",
  "payroll.salary": "SALARY",
  "payroll.advance": "ADVANCE",
  "payroll.dueTodayHeader": "DUE TODAY",
  "payroll.dueMinusAdvance": "DUE − ADV",
  "pos.pointOfSale": "Point of Sale",
  "pos.dailyBook": "Daily Book",
  "pos.inventory": "Inventory",
  "pos.priceList": "Price List",
  "pos.transfer": "Transfer",
  "pos.orders": "Orders",
  "pos.settings": "Settings",
  "pos.stockTransfer": "Stock Transfer",
  "pos.stockTransferDescription": "Transfer stock between locations",
  "pos.from": "From",
  "pos.to": "To",
  "pos.date": "Date",
  "pos.selectDestination": "Select destination...",
  "pos.item": "Item",
  "pos.quantity": "Quantity",
  "pos.typeToSearch": "Type to search...",
  "pos.totalQty": "Total Qty",
  "pos.totalItems": "Total Items",
  "pos.notesOptional": "Notes (optional)",
  "pos.optional": "Optional",
  "pos.saveTransfer": "Save Transfer",
  "pos.export": "Export",
} as const;

export type ApplicationTranslationKey = keyof typeof applicationEnglishTranslations;
export type ApplicationTranslationCatalog = {
  [K in ApplicationTranslationKey]: string;
};

type NonEnglishApplicationLanguage = Exclude<ApplicationLanguage, "en">;

const loadedCatalogs: Partial<Record<NonEnglishApplicationLanguage, ApplicationTranslationCatalog>> = {};
const catalogLoadPromises: Partial<Record<NonEnglishApplicationLanguage, Promise<void>>> = {};
let catalogVersion = 0;

export function isApplicationTranslationCatalogLoaded(language: ApplicationLanguage): boolean {
  return language === "en" || Boolean(loadedCatalogs[language]);
}

export function getLoadedApplicationTranslationCatalog(
  language: NonEnglishApplicationLanguage
): ApplicationTranslationCatalog | null {
  return loadedCatalogs[language] ?? null;
}

export function getApplicationTranslationCatalogVersion(): number {
  return catalogVersion;
}

export async function loadApplicationTranslationCatalog(language: ApplicationLanguage): Promise<void> {
  if (language === "en" || loadedCatalogs[language]) return;

  const existing = catalogLoadPromises[language];
  if (existing) return existing;

  const promise = (
    language === "ar"
      ? import("./applicationTranslations.ar").then((module) => module.applicationArabicTranslations)
      : import("./applicationTranslations.fr").then((module) => module.applicationFrenchTranslations)
  )
    .then((catalog) => {
      loadedCatalogs[language] = catalog;
      catalogVersion += 1;
    })
    .finally(() => {
      delete catalogLoadPromises[language];
    });

  catalogLoadPromises[language] = promise;
  return promise;
}

export function translateApplicationText(key: ApplicationTranslationKey, language: ApplicationLanguage): string {
  if (language === "en") return applicationEnglishTranslations[key] ?? key;
  return loadedCatalogs[language]?.[key] ?? applicationEnglishTranslations[key] ?? key;
}
