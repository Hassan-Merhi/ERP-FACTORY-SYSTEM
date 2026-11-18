/**
 * Deployment example policy. Check declarations, not narrative comments.
 * Keep this separate from consumer matching so it is fixture-testable.
 */
export const RETIRED_ENV_KEYS = Object.freeze([
  "ERP_REPAIR_FACTORY_RENT_SAFE_20261109",
  "ERP_REWORK_POS_JNAH_VOUCHERS_20261109",
]);

export function checkEnvExamplePolicy(examples, retired = RETIRED_ENV_KEYS) {
  const retiredSet = new Set(retired);
  const failures = [];
  const assignments = new Map();
  for (const [file, source] of Object.entries(examples)) {
    const lines = source.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const m = lines[index].match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (!m) continue;
      const name = m[1];
      const location = `${file}:${index + 1}`;
      if (retiredSet.has(name)) failures.push(`${location}: retired flag ${name} must not be documented again`);
      const first = assignments.get(name);
      if (first?.file === file) {
        failures.push(`${location}: duplicate ${name} (first at ${first.location})`);
      } else if (!first) {
        assignments.set(name, { file, location });
      }
    }
  }
  return { failures, declarationCount: [...Object.values(examples)].reduce((n,s) => n + [...s.matchAll(/^\s*#?\s*[A-Z][A-Z0-9_]*\s*=/gm)].length, 0) };
}
