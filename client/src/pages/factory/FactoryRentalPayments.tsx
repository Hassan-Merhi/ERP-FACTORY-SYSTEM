import RentalPaymentsLog from "@/pages/properties/RentalPaymentsLog";
import { ClipboardList } from "lucide-react";

export default function FactoryRentalPayments() {
  return (
    <RentalPaymentsLog
      pageTitle="Factory — Rental Payments Log"
      pageIcon={<ClipboardList className="h-7 w-7 text-orange-600" />}
      testIdPrefix="factory-rental"
      rentalModule="FACTORY"
    />
  );
}
