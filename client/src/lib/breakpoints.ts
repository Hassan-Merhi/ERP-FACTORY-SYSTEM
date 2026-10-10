/**
 * The responsive breakpoints the app's hooks and shells agree on. Tailwind's `sm`/`md`/`lg`
 * are 640/768/1024; the stylesheets under client/src use the matching `max-width` values
 * (639px / 767px / 1023px), so a width is never both "phone" and "md" at once.
 *
 * - Below 768px (`md`) the sidebar slides over instead of pinning (`useIsMobile`).
 * - Phones are below 640px (`sm`), or any short touch screen such as a landscape phone
 *   (`useErpPhoneLayout`, `ERP_PHONE_LAYOUT_QUERY`).
 * - Tablets (768–1023px) keep desktop layouts but start with the sidebar collapsed; it pins
 *   open by default from 1024px (`lg`, `SIDEBAR_PINNED_QUERY`).
 */
export const PHONE_MAX_WIDTH = 639;
export const MOBILE_BREAKPOINT = 768;
export const SIDEBAR_PINNED_MIN_WIDTH = 1024;

export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;
export const ERP_PHONE_LAYOUT_QUERY = `(max-width: ${PHONE_MAX_WIDTH}px), (hover: none) and (pointer: coarse) and (max-height: 500px)`;
export const SIDEBAR_PINNED_QUERY = `(min-width: ${SIDEBAR_PINNED_MIN_WIDTH}px)`;
