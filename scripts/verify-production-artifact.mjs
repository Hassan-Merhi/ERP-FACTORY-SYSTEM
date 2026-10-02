#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { resolve } from "node:path";

const root = process.cwd();
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const bundlePath = resolve(root, "dist/index.js");
const requiredFiles = [
  bundlePath,
  resolve(root, "server/startupPreload.mjs"),
  resolve(root, "server/schemaPreload.mjs"),
  resolve(root, "server/exportBufferBridge.mjs"),
  resolve(root, "server/scheduledAttachmentBridge.mjs"),
  resolve(root, "server/apiPaginationBridge.mjs"),
  resolve(root, "server/runtimeMemoryGuard.mjs"),
];

function tokenizeModuleSyntax(source) {
  const tokens = [];
  let index = 0;

  const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char);
  const isIdentifierPart = (char) => /[A-Za-z0-9_$]/.test(char);

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }

    if (char === "`" ) {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "`") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          value += source[index];
          if (index + 1 < source.length) value += source[index + 1];
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        value += source[index];
        index += 1;
      }
      tokens.push({ type: "string", value });
      continue;
    }

    if (isIdentifierStart(char)) {
      let value = char;
      index += 1;
      while (index < source.length && isIdentifierPart(source[index])) {
        value += source[index];
        index += 1;
      }
      tokens.push({ type: "identifier", value });
      continue;
    }

    tokens.push({ type: "punctuator", value: char });
    index += 1;
  }

  return tokens;
}

function collectRuntimeImports(source) {
  const tokens = tokenizeModuleSyntax(source);
  const imports = new Set();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "identifier") continue;

    if (token.value === "require" && tokens[index + 1]?.value === "(" && tokens[index + 2]?.type === "string") {
      imports.add(tokens[index + 2].value);
      continue;
    }

    if (token.value === "import") {
      const next = tokens[index + 1];
      // `import.meta` is not a module specifier — skip it so the static
      // `from` scan below doesn't run away into later code.
      if (next?.value === ".") continue;
      // Dynamic `import(...)`: capture only string-literal arguments; a
      // non-literal (e.g. `import(variable)`) has no static specifier, so
      // skip it rather than scanning forward for an unrelated `from`.
      if (next?.value === "(") {
        if (tokens[index + 2]?.type === "string") imports.add(tokens[index + 2].value);
        continue;
      }
      // Side-effect import: `import "x"`.
      if (next?.type === "string") {
        imports.add(next.value);
        continue;
      }
      // Otherwise fall through to the static `import … from "x"` scan below.
    }

    if (token.value === "import" || token.value === "export") {
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.value === ";") break;
        if (candidate.type === "identifier" && candidate.value === "from" && tokens[cursor + 1]?.type === "string") {
          imports.add(tokens[cursor + 1].value);
          break;
        }
      }
    }
  }

  return imports;
}

function isInternalSpecifier(specifier, builtins) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("http:") ||
    specifier.startsWith("https:") ||
    builtins.has(specifier)
  );
}

const errors = [];
for (const file of requiredFiles) {
  if (!existsSync(file)) errors.push(`Missing production runtime file: ${file.replace(`${root}/`, "")}`);
}

if (existsSync(bundlePath)) {
  const source = readFileSync(bundlePath, "utf8");
  const imports = collectRuntimeImports(source);
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  // The production deploy (render.yaml) runs `npm ci` without --omit=dev, so
  // devDependencies are installed and resolvable at runtime alongside deps.
  // Accept both; still fail on packages declared in neither.
  const declared = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);
  const require = createRequire(import.meta.url);

  for (const specifier of imports) {
    if (isInternalSpecifier(specifier, builtins)) continue;
    // Defend against tokenizer noise: the hand-rolled tokenizer can mis-read a
    // regex literal (which may contain quote characters) as a string, yielding
    // a bogus "specifier" made of surrounding code. A real bare module
    // specifier never contains whitespace or JS punctuation, so skip those.
    if (/[\s(){}=;`,]/.test(specifier)) continue;
    const packageName = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
    if (!declared.has(packageName)) {
      errors.push(`Runtime import ${specifier} is not declared in dependencies`);
      continue;
    }
    try {
      require.resolve(packageName);
    } catch (error) {
      errors.push(`Runtime dependency ${packageName} cannot be resolved: ${error.message}`);
    }
  }
}

if (errors.length) {
  console.error("PRODUCTION ARTIFACT VERIFICATION FAILED");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("Production artifact verification passed: bundle, preload files, and runtime imports are deployable.");
