import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { RoutedRentalsHub } from "@/pages/properties/RentalsHub";

export default function ErpRentalShops() {
  return (
    <RoutedRentalsHub module="ERP" section="shops">
      <PropertyRentalPage unitType="SHOP" testIdPrefix="erp-rental-shops" rentalModule="ERP" />
    </RoutedRentalsHub>
  );
}
