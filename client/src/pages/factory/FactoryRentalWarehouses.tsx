import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { RoutedRentalsHub } from "@/pages/properties/RentalsHub";
import { useFactoryRentalSections } from "./useFactoryRentalSections";

export default function FactoryRentalWarehouses() {
  const sections = useFactoryRentalSections();
  return (
    <RoutedRentalsHub module="FACTORY" section="warehouses" sections={sections}>
      <PropertyRentalPage unitType="WAREHOUSE" testIdPrefix="factory-rental-warehouses" rentalModule="FACTORY" />
    </RoutedRentalsHub>
  );
}
