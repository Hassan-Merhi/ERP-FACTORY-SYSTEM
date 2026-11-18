import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { RoutedRentalsHub } from "@/pages/properties/RentalsHub";

export default function ErpRentalWarehouses() {
  return (
    <RoutedRentalsHub module="ERP" section="warehouses">
      <PropertyRentalPage unitType="WAREHOUSE" testIdPrefix="erp-rental-warehouses" rentalModule="ERP" />
    </RoutedRentalsHub>
  );
}
