import { StockTransferOrderView } from "./stock-transfer-order/StockTransferOrderView";
import { useStockTransferOrderModel } from "./stock-transfer-order/useStockTransferOrderModel";

interface StockTransferOrderProps {
  onSwitchToNormalView?: () => void;
}

export default function StockTransferOrder({ onSwitchToNormalView }: StockTransferOrderProps = {}) {
  const model = useStockTransferOrderModel();
  return <StockTransferOrderView model={model} onSwitchToNormalView={onSwitchToNormalView} />;
}
