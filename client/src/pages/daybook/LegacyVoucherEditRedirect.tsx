import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveVoucherEditDestination, voucherDetailPath } from "./voucherEditRoute";

/** `/vouchers`, `/factory/vouchers` or `/properties/vouchers`, from the old edit URL. */
function vouchersBaseFor(location: string): string {
  const index = location.indexOf("/vouchers/");
  return index >= 0 ? `${location.slice(0, index)}/vouchers` : "/vouchers";
}

/**
 * The separate voucher edit page (`/vouchers/:id/edit` and its Factory and Properties twins) is
 * retired: the editor Daybook's Edit opens (`/vouchers?edit=`) is the only one. Old links and
 * bookmarks look the voucher up and replace themselves with that destination.
 */
export default function LegacyVoucherEditRedirect() {
  const { id } = useParams<{ id: string }>();
  const [location, navigate] = useLocation();
  const vouchersBase = vouchersBaseFor(location);
  const voucherId = Number(id);
  const validId = Number.isInteger(voucherId) && voucherId > 0;

  const { data: voucher, isError } = useQuery<{ id: number; voucherType: string }>({
    queryKey: [`/api/vouchers/${voucherId}`],
    enabled: validId,
    retry: false,
  });

  useEffect(() => {
    if (!validId) {
      navigate(vouchersBase, { replace: true });
      return;
    }
    if (isError) {
      navigate(voucherDetailPath(voucherId, vouchersBase), { replace: true });
      return;
    }
    if (!voucher) return;
    let cancelled = false;
    void resolveVoucherEditDestination({ id: voucherId, voucherType: voucher.voucherType }, vouchersBase).then(
      (destination) => {
        if (!cancelled) navigate(destination, { replace: true });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [isError, navigate, validId, voucher, voucherId, vouchersBase]);

  return (
    <div className="space-y-6" data-testid="legacy-voucher-edit-redirect">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-[400px] w-full" />
    </div>
  );
}
