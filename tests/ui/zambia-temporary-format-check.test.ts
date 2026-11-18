/** Temporary verification-only: emit exact Prettier output for branch source files. */
import { readFileSync } from "node:fs";
import * as prettier from "prettier";
import { it } from "vitest";

const paths = [
  "client/src/pages/pos/POSDaybookDialogSection.tsx",
  "client/src/pages/pos/POSDaybookEditPanel.tsx",
  "client/src/pages/pos/pos-components/InvoiceTemplate.tsx",
  "client/src/pages/pos/posdaybook/editSalePayload.ts",
  "server/middleware/posSaleEditWindow.ts",
  "server/services/pos/edit/posDaybookEditGuard.ts",
  "server/services/pos/posPriceListEdit.ts",
  "tests/pos-customer-access-policy.test.ts",
  "tests/pos-daybook-edit-http.test.ts",
  "tests/pos-daybook-edit-policy.test.ts",
  "tests/ui/pos-daybook-edit-payload.test.ts",
  "tests/zambia-pos-price-edit.test.ts",
  "client/src/pages/settings/users/PermissionSummaryCard.tsx",
  "shared/posDaybookEditPolicy.ts",
  "shared/posCustomerAccess.ts",
  "tests/ui/pos-price-list-page-behavior.test.tsx"
];

it("emits formatter output for branch compliance", async () => {
  for (const path of paths) {
    const original = readFileSync(path, "utf8");
    const options = (await prettier.resolveConfig(path)) ?? {};
    const formatted = await prettier.format(original, { ...options, filepath: path });
    if (formatted !== original) {
      console.log(`ZAMBIA_PRETTIER_B64:${path}:${Buffer.from(formatted, "utf8").toString("base64")}`);
    }
  }
});
