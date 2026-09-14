import { useCompany } from "@/contexts/CompanyContext";
import POSOriginal from "./POS";
import RetailPOS from "./RetailPOS";

// Retail companies use an exact-variant POS backed by dedicated retail stock.
// Supplier Partner and normal ERP companies keep the existing POS unchanged.
export default function POSPage() {
  const { selectedCompany } = useCompany();
  if (selectedCompany?.companyType === "retail") return <RetailPOS />;
  return <POSOriginal />;
}
