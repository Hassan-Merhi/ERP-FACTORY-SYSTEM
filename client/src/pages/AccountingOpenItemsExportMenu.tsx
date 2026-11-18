import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import type { PartyView, RentalView } from "./accountingOpenItemsTypes";

/** Excel export of the rental dues or the party's posted documents, whichever the page shows. */
export function OpenItemsExportMenu({
  asOfDate,
  party,
  partyLabel,
  partyId,
  rent,
  rentalModule,
}: {
  asOfDate: string;
  party: PartyView | null;
  partyLabel: string;
  partyId: string;
  rent: RentalView | null;
  rentalModule: string;
}) {
  return (
    <>
      {rent && (
        <RowsExportMenu
          title="Open Items"
          sheetName="Rental dues"
          filters={[{ label: "Rental", value: `${rentalModule} · ${rent.currency}` }]}
          period={{ to: asOfDate }}
          rows={rent.items}
          columns={[
            { header: "Due month", value: (row) => `${row.year}-${String(row.month).padStart(2, "0")}` },
            { header: "Due date", value: (row) => row.dueDate },
            { header: "Expected", value: (row) => row.expectedAmount, type: "number" },
            { header: "Paid", value: (row) => row.paidAmount, type: "number" },
            { header: "Unpaid", value: (row) => row.outstandingAmount, type: "number" },
            { header: "Status", value: (row) => row.status },
          ]}
          resource="erp.accounts"
          data-testid="button-export-open-items"
        />
      )}
      {party && (
        <RowsExportMenu
          title="Open Items"
          sheetName="Posted documents"
          filters={[{ label: partyLabel, value: partyId }]}
          period={{ to: asOfDate }}
          rows={party.items}
          columns={[
            { header: "Voucher", value: (item) => item.voucherNumber },
            { header: "Entry", value: (item) => item.entryId, type: "number" },
            { header: "Date", value: (item) => item.businessDate },
            { header: "Due date", value: (item) => item.dueDate },
            {
              header: "Days overdue",
              value: (item) => (item.overdueDays && item.overdueDays > 0 ? item.overdueDays : null),
              type: "number",
            },
            { header: "Type", value: (item) => `${item.side} · ${item.voucherType}` },
            { header: "Currency", value: (item) => item.currency },
            {
              header: "Currency verified",
              value: (item) => (item.currencyVerified ? "Yes" : "No — USD base displayed"),
            },
            { header: "Original", value: (item) => item.originalAmount, type: "number" },
            { header: "Matched", value: (item) => item.matchedAmount, type: "number" },
            { header: "Remaining", value: (item) => item.outstandingAmount, type: "number" },
            { header: "Status", value: (item) => item.status },
            {
              header: "Matches",
              value: (item) =>
                item.allocations
                  .map((link) => `#${link.matchId}: entry ${link.otherEntryId} · ${link.amount}`)
                  .join("; "),
            },
          ]}
          resource="erp.accounts"
          data-testid="button-export-open-items"
        />
      )}
    </>
  );
}
