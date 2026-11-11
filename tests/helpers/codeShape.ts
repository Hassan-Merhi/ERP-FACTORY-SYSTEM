/**
 * Reduces source text to a layout-independent shape, so a contract test that
 * looks for a code fragment keeps passing when the formatter rewraps a line,
 * switches quote style, adds a trailing comma or parenthesises an arrow
 * parameter. Apply it to both the file that was read and the expected fragment.
 */
export function codeShape(text: string): string {
  return text
    .replace(/\s+/g, "")
    .replace(/'/g, '"')
    .replace(/;/g, "")
    .replace(/,(?=[)\]}])/g, "")
    .replace(/\(([A-Za-z_$][\w$]*)\)=>/g, "$1=>")
    .replace(/&&\((?=<|$)/g, "&&");
}

/** Shapes text for comparison; leaves arrays and other values untouched. */
export function shaped<T>(value: T): T | string {
  return typeof value === "string" ? codeShape(value) : value;
}

/** The fragment to look for in `subject`: shaped when the subject is text, verbatim otherwise. */
export function fragmentFor(subject: unknown, fragment: string): string {
  return typeof subject === "string" ? codeShape(fragment) : fragment;
}
