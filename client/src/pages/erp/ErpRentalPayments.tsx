import RentalPaymentsLog from "@/pages/properties/RentalPaymentsLog";
import { ClipboardList } from "lucide-react";

export default function ErpRentalPayments() {
  return (
    <RentalPaymentsLog
      pageTitle="ERP — Rental Payments Log"
      pageIcon={<ClipboardList className="h-5 w-5 text-blue-600" />}
      testIdPrefix="erp-rental"
      apiBase="/api/erp/rental"
    />
  );
}
