// Extracted from ./FactoryFrenchCatalogManager.tsx

export interface FrenchCatalogRow {
  id: number;
  articleCode: string | null;
  nameEn: string;
  nameAr: string | null;
  nameFr: string | null;
  descriptionEn: string | null;
  descriptionAr: string | null;
  descriptionFr: string | null;
  categoryId: number | null;
  categoryNameEn: string | null;
  categoryNameAr: string | null;
  categoryNameFr: string | null;
}

export interface PreviewRow {
  rowNumber: number;
  articleCode: string;
  nameFr: string | null;
  categoryNameFr: string | null;
  descriptionFr: string | null;
  productId: number | null;
  categoryId: number | null;
  status: "ready" | "unknown";
}

export async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { credentials: "include", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
  return payload;
}
