import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { Store } from "lucide-react";

export default function ErpRentalShops() {
  return (
    <PropertyRentalPage
      unitType="SHOP"
      pageTitle="ERP — Shop Rentals"
      pageIcon={<Store className="h-5 w-5 text-blue-600" />}
      testIdPrefix="erp-rental-shops"
      rentalModule="ERP"
      paymentsLogUrl="/erp/rental/payments"
    />
  );
}
