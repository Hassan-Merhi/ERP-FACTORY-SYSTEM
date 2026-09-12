/**
 * SafeStyle — the only approved way to render an inline `<style>` block.
 *
 * The CSS is passed as React text children, which React mounts as a DOM text
 * node. A text node can never break out of its element, so even a hostile
 * payload such as `</style><script>…` is rendered inert — unlike
 * `dangerouslySetInnerHTML`, which parses its input as HTML and *would*
 * break out. Do not reintroduce `dangerouslySetInnerHTML` for style tags;
 * an ESLint rule (`no-restricted-syntax`) fails the build if it returns.
 */
export function SafeStyle({ css }: { css: string }) {
  if (import.meta.env.DEV && css.includes("</style")) {
    // Harmless at runtime (text nodes cannot break out), but almost certainly
    // a bug in the caller — surface it loudly during development.
    console.warn("[SafeStyle] CSS contains a literal </style> sequence; it will be rendered as inert text.");
  }
  return <style>{css}</style>;
}
