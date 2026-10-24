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
  // Retail uses the Stock Transfer voucher tab instead of the Transfer Order editor.
  if (selectedCompany?.companyType === "retail") {
    return <Redirect replace to="/vouchers?tab=transfer" />;
  }
  return <StockTransferOrderEditor {...props} />;
}
