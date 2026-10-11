import { useEffect, useState } from "react";

import { ERP_PHONE_LAYOUT_QUERY, PHONE_MAX_WIDTH } from "@/lib/breakpoints";

/**
 * Media query for the ERP phone interaction model.
 *
 * Portrait phones are narrower than Tailwind's `sm` breakpoint. Landscape
 * phones (for example 852x393) cross `sm`/`md` widths but are still
 * short-height coarse-pointer devices, so they keep the phone model too — the
 * same rule `erp-mobile-operations.css` applies.
 */
export { ERP_PHONE_LAYOUT_QUERY };

function matchesPhoneLayout(): boolean {
  if (typeof window === "undefined") return false;
  if (typeof window.matchMedia !== "function") return window.innerWidth <= PHONE_MAX_WIDTH;
  return window.matchMedia(ERP_PHONE_LAYOUT_QUERY).matches;
}

/** True while the ERP should use its phone layouts (filter sheets, card lists). */
export function useErpPhoneLayout(): boolean {
  const [isPhone, setIsPhone] = useState(matchesPhoneLayout);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      const update = () => setIsPhone(window.innerWidth <= PHONE_MAX_WIDTH);
      update();
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const mql = window.matchMedia(ERP_PHONE_LAYOUT_QUERY);
    const onChange = () => setIsPhone(mql.matches);
    onChange();

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return isPhone;
}
