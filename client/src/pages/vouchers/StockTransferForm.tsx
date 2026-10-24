import { useCompany } from "@/contexts/CompanyContext";
import type { StockTransferFormProps } from "./stocktransferform/types";
import { RetailVoucherTransferForm } from "./stock-transfer-form/RetailVoucherTransferForm";
import { StockTransferFormView } from "./stock-transfer-form/StockTransferHeader";
import { useStockTransferFormModel } from "./stock-transfer-form/useStockTransferFormModel";

function StandardStockTransferForm(props: StockTransferFormProps) {
  const model = useStockTransferFormModel(props);
  return <StockTransferFormView model={model} />;
}

export function StockTransferForm(props: StockTransferFormProps) {
  const { selectedCompany } = useCompany();
  // A retail variant ID is NOT an ERP stockItemId. Editing an existing legacy
  // voucher still uses the original form, but new retail transfers operate on
  // the retail stock ledger and its exact barcode/color/size variants.
  if (selectedCompany?.companyType === "retail" && !props.voucherIdToEdit) {
    return <RetailVoucherTransferForm isPOS={props.isPOS} />;
  }
  return <StandardStockTransferForm {...props} />;
}
