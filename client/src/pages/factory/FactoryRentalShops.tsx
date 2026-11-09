import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import "./factory-rental-shops.css";
import { Store } from "lucide-react";

export default function FactoryRentalShops() {
  return (
    <PropertyRentalPage
      unitType="SHOP"
      pageTitle="Factory — Shop Rentals"
      pageIcon={<Store className="h-7 w-7 text-orange-600" />}
      testIdPrefix="factory-rental-shops"
      rentalModule="FACTORY"
      paymentsLogUrl="/factory/rental/payments"
    />
  );
}
