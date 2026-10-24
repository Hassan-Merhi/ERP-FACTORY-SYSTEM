import { Redirect } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { StockTransferOrderView } from "./stock-transfer-order/StockTransferOrderView";
import { useStockTransferOrderModel } from "./stock-transfer-order/useStockTransferOrderModel";

interface StockTransferOrderProps {
  onSwitchToNormalView?: () => void;
}

function StockTransferOrderEditor({ onSwitchToNormalView }: StockTransferOrderProps) {
  const model = useStockTransferOrderModel();
  return <StockTransferOrderView model={model} onSwitchToNormalView={onSwitchToNormalView} />;
}

export default function StockTransferOrder(props: StockTransferOrderProps = {}) {
  const { selectedCompany } = useCompany();
  // Retail has its own barcode/variant stock operations; a direct link must
  // never mount the generic ERP Transfer Order form for a Retail company.
  if (selectedCompany?.companyType === "retail") {
    return <Redirect replace to="/retail/stock" />;
  }
  return <StockTransferOrderEditor {...props} />;
}
