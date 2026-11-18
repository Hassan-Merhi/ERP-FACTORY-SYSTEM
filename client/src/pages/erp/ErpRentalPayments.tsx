import RentalPaymentsLog from "@/pages/properties/RentalPaymentsLog";
import { RoutedRentalsHub } from "@/pages/properties/RentalsHub";

export default function ErpRentalPayments() {
  return (
    <RoutedRentalsHub module="ERP" section="payments">
      <RentalPaymentsLog testIdPrefix="erp-rental" rentalModule="ERP" />
    </RoutedRentalsHub>
  );
}
