import { type ReactNode, useState } from "react";
import { LogOut, MoreHorizontal, Search, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CompanySelector } from "@/components/CompanySelector";
import { CurrencyToggle } from "@/components/CurrencyToggle";
import { NotificationsCenter } from "@/components/NotificationsCenter";
import { PendingSyncIndicator } from "@/components/PendingSyncIndicator";
import { ThemeToggle } from "@/components/ThemeToggle";
import { UserMenu } from "@/components/UserMenu";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  useApplicationDirection,
  useApplicationLanguage,
} from "@/contexts/ApplicationLanguageContext";

interface WorkspaceUser {
  username: string;
  role: string;
}

interface WorkspaceHeaderControlsProps {
  accentColor: string;
  user: WorkspaceUser;
  onLogout: () => void;
}

interface MobileWorkspaceControlsProps extends WorkspaceHeaderControlsProps {
  onSearchOpen?: () => void;
  showSearch: boolean;
  extraActions?: ReactNode;
}

function getInitials(username: string) {
  const words = username.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return username.substring(0, 2).toUpperCase();
}

export function WorkspaceHeaderControls({ accentColor, user, onLogout }: WorkspaceHeaderControlsProps) {
  return (
    <>
      <div className="hidden sm:block">
        <PendingSyncIndicator />
      </div>

      <NotificationsCenter />

      <div className="mx-1 hidden h-5 w-px bg-border/60 sm:block" />

      <div className="hidden sm:block">
        <UserMenu accentColor={accentColor} user={user} onLogout={onLogout} />
      </div>

      <div className="mx-1 hidden h-5 w-px bg-border/60 sm:block" />

      <span className="hidden sm:block">
        <CurrencyToggle />
      </span>
    </>
  );
}

export default function MobileWorkspaceControls({
  accentColor,
  user,
  onLogout,
  onSearchOpen,
  showSearch,
  extraActions,
}: MobileWorkspaceControlsProps) {
  const [open, setOpen] = useState(false);
  const direction = useApplicationDirection();
  const { t } = useApplicationLanguage();

  const openSearch = () => {
    setOpen(false);
    onSearchOpen?.();
  };

  const logout = () => {
    setOpen(false);
    onLogout();
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("accessibility.openWorkspaceControls")}
          data-testid="button-mobile-controls"
          className="h-10 w-10 shrink-0 sm:hidden"
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent
        side={direction === "rtl" ? "left" : "right"}
        className="flex w-[calc(100vw_-_0.5rem)] max-w-sm flex-col gap-0 p-0"
      >
        <SheetHeader className="border-b px-4 pb-3 pt-[max(1rem,var(--safe-area-top))] text-start">
          <SheetTitle>{t("workspace.controls")}</SheetTitle>
          <SheetDescription>{t("workspace.controlsDescription")}</SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white"
              style={{ backgroundColor: accentColor }}
              aria-hidden="true"
            >
              {getInitials(user.username)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold" data-business-value="true">
                {user.username}
              </p>
              <p className="truncate text-xs text-muted-foreground" data-business-value="true">
                {user.role}
              </p>
            </div>
            <UserRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </div>

          <div className="rounded-lg border p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Company
            </p>
            <div className="[&>button]:w-full">
              <CompanySelector />
            </div>
          </div>

          {showSearch && onSearchOpen && (
            <Button
              variant="outline"
              onClick={openSearch}
              data-testid="button-mobile-controls-search"
              className="w-full justify-start gap-2"
            >
              <Search className="h-4 w-4" aria-hidden="true" />
              {t("workspace.search")}
            </Button>
          )}

          <div className="rounded-lg border p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("workspace.accountLanguage")}
            </p>
            <UserMenu accentColor={accentColor} user={user} onLogout={logout} />
          </div>

          {extraActions && <div className="grid gap-2 [&>*]:w-full">{extraActions}</div>}

          <div className="rounded-lg border p-3">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("workspace.statusDisplay")}
            </p>
            <div className="flex items-center justify-between gap-3 border-b pb-3">
              <span className="text-sm">{t("workspace.pendingSync")}</span>
              <PendingSyncIndicator />
            </div>
            <div className="grid grid-cols-2 gap-2 pt-3">
              <div className="[&>button]:w-full">
                <CurrencyToggle />
              </div>
              <div className="flex min-h-10 items-center justify-between rounded-md border px-3">
                <span className="text-sm">{t("workspace.theme")}</span>
                <ThemeToggle />
              </div>
            </div>
          </div>

          <Button
            variant="destructive"
            onClick={logout}
            data-testid="button-mobile-logout"
            className="mt-auto w-full gap-2"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t("common.logout")}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
