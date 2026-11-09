import RentalPaymentsLog from "./RentalPaymentsLog";
import { ClipboardList } from "lucide-react";

export default function PropertiesRentalPayments() {
  return (
    <RentalPaymentsLog
      pageTitle="Properties — Payments Log"
      pageIcon={<ClipboardList className="h-7 w-7 text-indigo-600" />}
      testIdPrefix="prop-rental"
      rentalModule="PROPERTIES"
    />
  );
}
