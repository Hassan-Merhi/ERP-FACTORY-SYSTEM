import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { Warehouse } from "lucide-react";

export default function FactoryRentalWarehouses() {
  return (
    <PropertyRentalPage
      unitType="WAREHOUSE"
      pageTitle="Factory — Warehouse Rentals"
      pageIcon={<Warehouse className="h-7 w-7 text-orange-600" />}
      testIdPrefix="factory-rental-warehouses"
      rentalModule="FACTORY"
    />
  );
}
