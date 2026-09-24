import PropertyRentalPage from "@/pages/properties/PropertyRentalPage";
import { Warehouse } from "lucide-react";

export default function ErpRentalWarehouses() {
  return (
    <PropertyRentalPage
      unitType="WAREHOUSE"
      pageTitle="ERP — Warehouse Rentals"
      pageIcon={<Warehouse className="h-5 w-5 text-blue-600" />}
      testIdPrefix="erp-rental-warehouses"
      apiBase="/api/erp/rental"
    />
  );
}
