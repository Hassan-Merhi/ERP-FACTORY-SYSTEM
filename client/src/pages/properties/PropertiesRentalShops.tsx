import PropertyRentalPage from "./PropertyRentalPage";
import { Store } from "lucide-react";

export default function PropertiesRentalShops() {
  return (
    <PropertyRentalPage
      rentalModule="PROPERTIES"
      unitType="SHOP"
      pageTitle="Properties — Shop Rentals"
      pageIcon={<Store className="h-7 w-7 text-purple-600" />}
      testIdPrefix="rental-shops"
      paymentsLogUrl="/properties/rentals?tab=payments"
    />
  );
}
