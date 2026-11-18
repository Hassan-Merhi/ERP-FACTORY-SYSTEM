// Extracted from ./FactoryMonthlyProductionMatrix.tsx to keep that module under the source-size cap.
import type { RouteComponentProps } from "wouter";

/** Routed standalone (receives route props) or embedded as a hub tab panel. */
export type EmbeddablePageProps = { embedded?: boolean } & Partial<RouteComponentProps>;

type Product = { id: number; name: string; articleCode: string; categoryName: string };

type MonthValue = { productId: number; month: string; quantity: number };

export type MatrixResponse = { products: Product[]; monthly: MonthValue[]; rowOrder: number[] };

export const currentMonth = () => {
  const now = new Date();
  return String(now.getFullYear()) + "-" + String(now.getMonth() + 1).padStart(2, "0");
};

export const prettyMonth = (month: string, locale?: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: "short", year: "numeric" });
};

export const csvCell = (value: string | number) => '"' + String(value).replace(/"/g, '""') + '"';
