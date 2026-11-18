import { type ReactNode, useEffect, useState } from "react";
import { ShoppingCart } from "lucide-react";
import { Sidebar, SidebarContent } from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/contexts/CompanyContext";
import {
  ModuleFooter,
  ModuleHeader,
  MODULE_ACCENT,
  NAV_COLOR,
  SidebarFlatLink,
  SidebarSectionGroup,
  type NavItem,
} from "@/components/sidebar/sidebarPrimitives";
import { usePosNavigationItems, type PosNavItem } from "./usePosNavigationItems";
import type { ShellUser } from "./shellUser";

interface PosSidebarProps {
  user: ShellUser;
  posImportEnabled: boolean;
  chatUnread: { count: number } | undefined;
  /** Station identity and back button, drawn by the shell above the navigation. */
  identity: ReactNode;
  onLogout: () => void;
}

function UnreadBadge({ count }: { count: number | undefined }) {
  if (count === undefined || count <= 0) return null;
  return (
    <Badge
      className="min-w-5 justify-center rounded-full px-1.5 text-[11px]"
      aria-label={`${count} unread`}
      data-testid="badge-chat-unread-pos"
    >
      {count}
    </Badge>
  );
}

/**
 * POS navigation drawn with the shared sidebar pieces ERP, Factory and Properties use. The items,
 * their order, visibility and test ids still come from `usePosNavigationItems`, so the POS role's
 * restricted navigation is unchanged; only the chrome is shared.
 */
export function PosSidebar({ user, posImportEnabled, chatUnread, identity, onLogout }: PosSidebarProps) {
  const { selectedCompany } = useCompany();
  const posNavItems = usePosNavigationItems({
    user,
    posImportEnabled,
    chatUnread,
    companyType: selectedCompany?.companyType,
  });
  const primaryNavItems = posNavItems.filter((item) => item.group === "primary");
  const toolNavItems = posNavItems.filter((item) => item.group === "tools");
  const toolsByPath = new Map<string, PosNavItem>(toolNavItems.map((item) => [item.path, item]));
  const toolsActive = toolNavItems.some((item) => item.active);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  useEffect(() => {
    if (toolsActive) setToolsExpanded(true);
  }, [toolsActive, selectedCompany?.id]);

  const toolsSection = {
    label: "More tools",
    color: NAV_COLOR.sales,
    items: toolNavItems.map((item): NavItem => ({
      title: item.label,
      url: item.path,
      icon: item.icon as NavItem["icon"],
    })),
  };

  return (
    <Sidebar className="premium-shell-sidebar" data-pos-sidebar="shared">
      <ModuleHeader icon={ShoppingCart} label="Business OS" tagline="Point of Sale" accent={MODULE_ACCENT.pos} />
      <SidebarContent className="premium-nav-scroll overflow-y-auto px-3 py-2">
        <div className="mb-3 flex items-center gap-2">{identity}</div>

        <nav aria-label="Point of sale navigation" className="mb-2 space-y-0.5">
          {primaryNavItems.map((item) => (
            <SidebarFlatLink
              key={item.path}
              href={item.path}
              icon={item.icon as NavItem["icon"]}
              label={item.label}
              color={NAV_COLOR.sales}
              active={item.active}
              testId={item.testId}
              trailing={<UnreadBadge count={item.badge} />}
            />
          ))}
        </nav>

        {toolNavItems.length > 0 && (
          <nav aria-label="Additional point of sale tools" className="border-t border-sidebar-border/60 pt-2">
            <SidebarSectionGroup
              section={toolsSection}
              isOpen={toolsExpanded}
              onToggle={() => setToolsExpanded((expanded) => !expanded)}
              sectionTestId="button-pos-more-tools"
              testIdFor={(navItem) => toolsByPath.get(navItem.url)?.testId ?? `link-pos-${navItem.url}`}
              trailingFor={(navItem) => <UnreadBadge count={toolsByPath.get(navItem.url)?.badge} />}
            />
          </nav>
        )}
      </SidebarContent>
      <div className="pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        <ModuleFooter
          user={{ username: user.username, role: "POS user" }}
          accent={MODULE_ACCENT.pos}
          onLogout={onLogout}
        />
      </div>
    </Sidebar>
  );
}
