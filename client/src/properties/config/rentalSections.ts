import { Building2, ClipboardList, Store, type LucideIcon } from "lucide-react";
import type { RentalModule } from "./rentalModulePolicy";

/**
 * One navigation model for rentals in every company type: a Rentals hub with
 * Warehouses / Shops / Payments tabs. Properties keeps its tab in `?tab=`;
 * ERP and Factory keep their existing per-section routes (each one is still
 * the route the Factory access guard checks), so every old URL keeps working.
 *
 * Titles and icons come only from here (owner decision 9: no "ERP —" /
 * "Factory —" prefix).
 */
export const RENTAL_SECTIONS = ["warehouses", "shops", "payments"] as const;
export type RentalSection = (typeof RENTAL_SECTIONS)[number];

type RentalSectionDefinition = Readonly<{ label: string; title: string; icon: LucideIcon }>;

export const RENTAL_SECTION_DEFINITIONS: Readonly<Record<RentalSection, RentalSectionDefinition>> = {
  warehouses: { label: "Warehouses", title: "Warehouse Rentals", icon: Building2 },
  shops: { label: "Shops", title: "Shop Rentals", icon: Store },
  payments: { label: "Payments", title: "Rental Payments Log", icon: ClipboardList },
};

export function rentalUnitSection(unitType: "WAREHOUSE" | "SHOP"): RentalSection {
  return unitType === "SHOP" ? "shops" : "warehouses";
}

/** The URL of one rental section; these are the routes that already existed. */
export function rentalSectionHref(module: RentalModule, section: RentalSection): string {
  if (module === "PROPERTIES")
    return section === "warehouses" ? "/properties/rentals" : `/properties/rentals?tab=${section}`;
  return `${module === "ERP" ? "/erp/rental" : "/factory/rental"}/${section}`;
}
