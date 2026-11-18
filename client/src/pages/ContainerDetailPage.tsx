import { useParams } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import ContainerDetailERP from "./ContainerDetail";
import { SpContainerDetailView } from "./SpContainerDetailView";

export default function ContainerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { selectedCompany } = useCompany();
  const isSupplierPartner = selectedCompany?.companyType === "supplier_partner";

  // ERP containers viewed from the SP list are tagged with ?src=erp — render
  // the standard ERP detail page directly without trying the SP lookup first.
  const srcErp = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("src") === "erp";

  if (!isSupplierPartner || srcErp) {
    return <ContainerDetailERP id={id} forceErp={srcErp} />;
  }

  return <SpContainerDetailView />;
}
