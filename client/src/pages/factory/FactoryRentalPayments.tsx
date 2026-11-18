import RentalPaymentsLog from "@/pages/properties/RentalPaymentsLog";
import { RoutedRentalsHub } from "@/pages/properties/RentalsHub";
import { useFactoryRentalSections } from "./useFactoryRentalSections";

export default function FactoryRentalPayments() {
  const sections = useFactoryRentalSections();
  return (
    <RoutedRentalsHub module="FACTORY" section="payments" sections={sections}>
      <RentalPaymentsLog testIdPrefix="factory-rental" rentalModule="FACTORY" />
    </RoutedRentalsHub>
  );
}
