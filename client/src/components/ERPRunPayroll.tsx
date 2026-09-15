import { ERPRunPayrollView } from "./erprunpayroll/ERPRunPayrollView";
import { CompactRunPayrollSelection } from "./erprunpayroll/CompactRunPayrollSelection";
import { useERPRunPayrollModel } from "./erprunpayroll/useERPRunPayrollModel";

export default function ERPRunPayroll() {
  const model = useERPRunPayrollModel();

  // Keep the existing preview, history and payment flows intact. Only the
  // first worker-selection step is replaced with the compact table UI.
  if (model.activeTab === "run" && model.step === 1) {
    return <CompactRunPayrollSelection model={model} />;
  }

  return <ERPRunPayrollView model={model} />;
}
