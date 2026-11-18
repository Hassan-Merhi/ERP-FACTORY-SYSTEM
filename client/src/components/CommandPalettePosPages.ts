// Extracted from ./CommandPalette.tsx to keep that module under the source-size cap.
import { ArrowLeftRight, Calendar, MapPin, Settings, Ship, ShoppingCart, Tag, Truck } from "lucide-react";
import type { PageEntry } from "./CommandPaletteDESCRIPTIONS";

export const posPages: PageEntry[] = [
  { label: "Point of Sale", description: "Cashier checkout", path: "/pos", icon: ShoppingCart },
  { label: "POS Daybook", description: "Daily POS log", path: "/pos-daybook", icon: Calendar },
  { label: "Location Inventory", description: "Stock levels by location", path: "/location-inventory", icon: MapPin },
  { label: "Transfer Orders", description: "POS stock transfer orders", path: "/pos-transfer-orders", icon: Truck },
  { label: "Price List", description: "Location pricing", path: "/pos-price-list", icon: Tag },
  {
    label: "Stock Transfer",
    description: "Transfer stock between locations",
    path: "/vouchers?tab=transfer",
    icon: ArrowLeftRight,
  },
  { label: "Containers OTW", description: "On-the-way containers", path: "/pos-containers", icon: Ship },
  { label: "My Settings", description: "Personal settings", path: "/pos-settings", icon: Settings },
];
