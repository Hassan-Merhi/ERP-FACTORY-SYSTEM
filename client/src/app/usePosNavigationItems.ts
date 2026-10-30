import type { ComponentType } from "react";
import { useLocation } from "wouter";
import {
  ShoppingCart,
  Ship,
  MapPin,
  BookOpen,
  Package,
  Users,
  Upload,
  MessageSquare,
  Cog,
  KeyRound,
  Tag,
  ClipboardList,
} from "lucide-react";

export interface PosNavItem {
  label: string;
  group: "primary" | "tools";
  icon: ComponentType<{ className?: string }>;
  active: boolean;
  testId: string;
  onClick: () => void;
  badge?: number;
}

interface PosNavigationUser {
  canAccessCustomers?: boolean;
  role?: string | null;
}

interface UsePosNavigationItemsParams {
  user: PosNavigationUser;
  posImportEnabled: boolean;
  chatUnread: { count: number } | undefined;
  companyType?: string | null;
}

/**
 * Builds the ordered list of POS sidebar navigation items.
 * Reads the current location internally via useLocation().
 */
export function usePosNavigationItems({
  user,
  posImportEnabled,
  chatUnread,
  companyType,
}: UsePosNavigationItemsParams): PosNavItem[] {
  const [currentLocation, setLocation] = useLocation();
  // Retail's POS route tree intentionally has fewer registered pages.
  if (companyType === "retail") {
    return [
      {
        label: "Point of Sale",
        group: "primary",
        icon: ShoppingCart,
        active: currentLocation === "/" || currentLocation === "/pos" || currentLocation === "/retail/pos",
        testId: "button-pos-tab",
        onClick: () => setLocation("/retail/pos"),
      },
      {
        label: "My Settings",
        group: "tools",
        icon: KeyRound,
        active: currentLocation === "/my-settings",
        testId: "button-pos-my-settings-tab",
        onClick: () => setLocation("/my-settings"),
      },
    ];
  }

  const isOnContainers = currentLocation === "/" || currentLocation.startsWith("/pos-containers");
  const isOnPOS = currentLocation === "/pos" || currentLocation === "/pos/" || currentLocation.startsWith("/pos/edit/");
  const isOnInventory = currentLocation === "/location-inventory";
  const isOnDaybook = currentLocation === "/pos-daybook";
  const isOnImport = currentLocation === "/pos-import";
  const isOnCustomers = currentLocation === "/pos-customers";
  const isOnTransfer = currentLocation.startsWith("/vouchers");
  const isOnChat = currentLocation === "/pos-chat";
  const isOnSettings = currentLocation === "/pos-settings";
  const isOnPriceList = currentLocation === "/pos-price-list";
  const isOnTransferOrders = currentLocation === "/pos-transfer-orders";

  const items: PosNavItem[] = [
    {
      label: "Point of Sale",
      group: "primary",
      icon: ShoppingCart,
      active: isOnPOS,
      testId: "button-pos-tab",
      onClick: () => setLocation("/pos"),
    },
    {
      label: "Daybook",
      group: "primary",
      icon: BookOpen,
      active: isOnDaybook,
      testId: "button-daybook-tab",
      onClick: () => setLocation("/pos-daybook"),
    },
    {
      label: "Inventory",
      group: "primary",
      icon: MapPin,
      active: isOnInventory,
      testId: "button-inventory-tab",
      onClick: () => setLocation("/location-inventory"),
    },
    {
      label: "Price List",
      group: "tools",
      icon: Tag,
      active: isOnPriceList,
      testId: "button-price-list-tab",
      onClick: () => setLocation("/pos-price-list"),
    },
    {
      label: "Transfer",
      group: "tools",
      icon: Package,
      active: isOnTransfer,
      testId: "button-stock-transfer-tab",
      onClick: () => setLocation("/vouchers?tab=transfer"),
    },
    {
      label: "Orders",
      group: "primary",
      icon: ClipboardList,
      active: isOnTransferOrders,
      testId: "button-transfer-orders-tab",
      onClick: () => setLocation("/pos-transfer-orders"),
    },
    {
      label: "Containers OTW",
      group: "primary",
      icon: Ship,
      active: isOnContainers,
      testId: "button-pos-containers-tab",
      onClick: () => setLocation("/pos-containers"),
    },
    ...(user?.canAccessCustomers
      ? [
          {
            label: "Customers",
            group: "tools" as const,
            icon: Users,
            active: isOnCustomers,
            testId: "button-customers-tab",
            onClick: () => setLocation("/pos-customers"),
          },
        ]
      : []),
    ...(posImportEnabled
      ? [
          {
            label: "Import",
            group: "tools" as const,
            icon: Upload,
            active: isOnImport,
            testId: "button-pos-import-tab",
            onClick: () => setLocation("/pos-import"),
          },
        ]
      : []),
    ...(user?.role === "Developer"
      ? [
          {
            label: "Chat",
            group: "tools" as const,
            icon: MessageSquare,
            active: isOnChat,
            testId: "button-chat-tab",
            onClick: () => setLocation("/pos-chat"),
            badge: chatUnread?.count || 0,
          },
        ]
      : []),
    {
      label: "Settings",
      group: "tools",
      icon: Cog,
      active: isOnSettings,
      testId: "button-settings-tab",
      onClick: () => setLocation("/pos-settings"),
    },
  ];

  return items;
}
