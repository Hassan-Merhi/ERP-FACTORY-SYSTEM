/**
 * Temporary CI verification fixture. Emits exact Prettier output, then delete
 * after formatter parity is restored. This test NEVER modifies repo files.
 */
import { readFileSync } from "node:fs";
import * as prettier from "prettier";
import { it } from "vitest";

const paths = [
  "client/src/pages/pos/POSCustomerOpeningFields.tsx",
  "client/src/pages/pos/POSCustomers.tsx",
  "client/src/pages/pos/POSDaybook.tsx",
  "client/src/pages/pos/POSDaybookDaybookResultsSection.tsx",
  "client/src/pages/pos/POSDaybookDialogSection.tsx",
  "client/src/pages/pos/POSDaybookEditPanel.tsx",
  "client/src/pages/pos/POSDaybookTransferDetails.tsx",
  "client/src/pages/pos/hooks/usePosMutations.ts",
  "client/src/pages/pos/pos-components/InvoiceTemplate.tsx",
  "client/src/pages/pos/pos-components/posInvoiceZmwTotals.ts",
  "client/src/pages/pos/posdaybook/editSalePayload.ts",
  "client/src/pages/pos/posdaybook/types.ts",
  "client/src/pages/pos/posdaybook/zmwDisplay.ts",
  "client/src/pages/pos/pospricelist/PriceListToolbar.tsx",
  "client/src/pages/pos/pospricelist/usePosPriceListModel.ts",
  "client/src/pages/pos/usePOSCustomersState.ts",
  "client/src/pages/pos/usePOSDaybookStatePart1.ts",
  "client/src/pages/settings/users/InlineRoleEditorView.tsx",
  "client/src/pages/settings/users/PermissionSummaryCard.tsx",
  "client/src/pages/settings/users/PosCustomerPermissionSwitch.tsx",
  "server/helpers/generateInvoicePdf.ts",
  "server/helpers/generateInvoicePdfBuildPdf.ts",
  "server/helpers/generateInvoicePdfWrapText.ts",
  "server/middleware/posCustomerPermission.ts",
  "server/middleware/posSaleEditWindow.ts",
  "server/routes/fiscal-transfers/pos-detail.ts",
  "server/routes/fiscal-transfers/reads.ts",
  "server/routes/pos/posCustomerRoutes.ts",
  "server/routes/pos/posEditSaleRoutes.ts",
  "server/routes/stock/groups-items/location-prices.ts",
  "server/routes/vouchers/sales-update/sales.ts",
  "server/routes/vouchers/voucherPaginationRoutes.ts",
  "server/routes/vouchers/voucherQueryRoutes.ts",
  "server/services/pos/createSaleService.ts",
  "server/services/pos/edit/posDaybookEditGuard.ts",
  "server/services/pos/edit/posEditSaleTypes.ts",
  "server/services/pos/edit/posZmwEditedAmounts.ts",
  "server/services/pos/edit/rebuildSaleAccounting.ts",
  "server/services/pos/edit/updateSaleService.ts",
  "server/services/pos/posDaybookTransferAccess.ts",
  "server/services/pos/posPriceListEdit.ts",
  "server/services/pos/posSaleTypes.ts",
  "server/services/pos/posVoucherNativeTotals.ts",
  "server/services/pos/posVoucherShiftOwnership.ts",
  "server/services/pos/posZmwRatePolicy.ts",
  "server/services/pos/postSaleAccounting.ts",
  "server/services/pos/saleAccountingLines.ts",
  "shared/posCustomerAccess.ts",
  "shared/posDaybookEditPolicy.ts",
  "shared/posDaybookTransferText.ts",
  "shared/posZmwMoney.ts",
  "tests/pos-customer-access-policy.test.ts",
  "tests/pos-customer-create-authorization.test.ts",
  "tests/pos-daybook-edit-http.test.ts",
  "tests/pos-daybook-edit-policy.test.ts",
  "tests/ui/pos-customer-permission-switch.test.tsx",
  "tests/ui/pos-daybook-edit-payload.test.ts",
  "tests/ui/pos-daybook-transfer-details.test.tsx",
  "tests/ui/pos-price-list-page-behavior.test.tsx",
  "tests/ui/wave4-page-interactions.test.tsx",
  "tests/ui/wave4-page-mounts.test.tsx",
  "tests/ui/wave4-populated-page-mounts.test.tsx",
  "tests/ui/zambia-pos-daybook-money.test.ts",
  "tests/zambia-pos-daybook-transfers.test.ts",
  "tests/zambia-pos-native-amounts.test.ts",
  "tests/zambia-pos-price-edit.test.ts"
];

it("reports exact formatter results for the Zambia branch", async () => {
  for (const path of paths) {
    const original = readFileSync(path, "utf8");
    const config = (await prettier.resolveConfig(path)) ?? {};
    const formatted = await prettier.format(original, { ...config, filepath: path });
    if (formatted !== original) {
      console.log(`ZAMBIA_FORMAT_B64:${path}:${Buffer.from(formatted, "utf8").toString("base64")}`);
    }
  }
});
