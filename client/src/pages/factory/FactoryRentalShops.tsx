import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { RoutedRentalsHub } from "@/pages/properties/RentalsHub";
import { useFactoryRentalSections } from "./useFactoryRentalSections";
import "./factory-rental-shops.css";

export default function FactoryRentalShops() {
  const sections = useFactoryRentalSections();
  return (
    <RoutedRentalsHub module="FACTORY" section="shops" sections={sections}>
      <PropertyRentalPage unitType="SHOP" testIdPrefix="factory-rental-shops" rentalModule="FACTORY" />
    </RoutedRentalsHub>
  );
}
