import PropertyRentalPage from "./PropertyRentalPage";
import { Building2 } from "lucide-react";

export default function PropertiesRentalWarehouses() {
  return (
    <PropertyRentalPage
      rentalModule="PROPERTIES"
      unitType="WAREHOUSE"
      pageTitle="Properties — Warehouse Rentals"
      pageIcon={<Building2 className="h-7 w-7 text-indigo-600" />}
      testIdPrefix="rental-warehouses"
      paymentsLogUrl="/properties/rentals?tab=payments"
    />
  );
}
