/**
 * Raw SQL construction-site scanner (library half of scripts/verify-raw-sql-allowlist.mjs).
 *
 * The scanner walks the TypeScript AST of every source file and reports each
 * place where SQL *text* is built from something other than string literals:
 *
 *   sql.raw              `sql.raw(x)` (any import alias of drizzle's `sql`)
 *   dynamic-identifier   `sql.identifier(x)` with a non-literal argument
 *   query-text           a template / concatenation passed straight to a
 *                        `.query` / `.execute` / `.unsafe` sink
 *   indirect-query-text  a sink receiving a local variable whose value is a
 *                        template / concatenation (or which is mutated with +=)
 *   assembled-sql-text   any SQL-shaped template / concatenation anywhere else
 *                        (helpers, wrappers, constants, loops)
 *   sql-text-replace     `.replace()` on SQL-shaped text with a dynamic value
 *   sql-array-join       SQL-shaped array literal with dynamic elements, joined
 *   plpgsql-execute      PL/pgSQL `EXECUTE` of dynamic text (in .sql files or
 *                        in SQL embedded in TypeScript)
 *
 * For every site it extracts the *dynamic parts* (template spans, concatenation
 * operands, arguments) and tries to prove each one injection-proof:
 *
 *   static   a string/number literal, a `const` bound to static values, a
 *            conditional choosing between static values, a lookup into a const
 *            object/array literal whose values are all static and which is
 *            never written to in the file, or `[...static].join(static)`.
 *   numeric  a value that can only be a JavaScript number when stringified
 *            (Number()/parseInt()/Math.*, `.length`, arithmetic, numeric
 *            for-loop counters). A number renders as [-0-9.e+] | NaN | Infinity
 *            and cannot carry quote, comment or statement syntax.
 *
 * A site whose every dynamic part is proven is recorded as auto-verified.
 * Anything else MUST be covered by a manual, source-bound review entry in
 * docs/security/raw-sql-allowlist.json. The proofs are intentionally narrow;
 * when in doubt the scanner reports the part as unproven.
 */
import ts from "typescript";
import { createHash } from "node:crypto";

export const SINK_METHODS = new Set(["query", "execute", "unsafe", "queryRaw", "executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]);

// SQL shape heuristics applied to the static text of a template/concatenation.
const SQL_SHAPE = [
  /\bSELECT\b[\s\S]*\bFROM\b/,
  /\bselect\s[\s\S]*\sfrom\s+[a-z_"]/,
  /\bINSERT\s+INTO\b/i,
  /\bUPDATE\s+[\w".]+\s+SET\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\s+(TABLE\s+)?[\w"]/,
  /\bALTER\s+(TABLE|INDEX|SEQUENCE|FUNCTION|ROLE|DATABASE|SCHEMA|POLICY|TYPE|VIEW)\b/i,
  /\bCREATE\s+(OR\s+REPLACE\s+)?(UNIQUE\s+)?(TABLE|INDEX|TRIGGER|FUNCTION|VIEW|POLICY|SCHEMA|SEQUENCE|DATABASE|ROLE|EXTENSION|TYPE|MATERIALIZED)\b/i,
  /\bDROP\s+(TABLE|INDEX|TRIGGER|FUNCTION|VIEW|POLICY|CONSTRAINT|DATABASE|SCHEMA|ROLE|SEQUENCE|TYPE|COLUMN|EXTENSION)\b/i,
  /\b(GRANT|REVOKE)\s+[\w ,]+\s+ON\b/i,
  /\bWHERE\b/,
  /\bORDER\s+BY\b/,
  /\bGROUP\s+BY\b/,
  /\bRETURNING\b/,
  /\bVALUES\s*\(/,
  /\bLOCK\s+TABLE\b/i,
  /\bDECLARE\s+\w+\s+(NO\s+)?(SCROLL\s+)?CURSOR\b/i,
  /\bON\s+CONFLICT\b/i,
  /\bEXECUTE\s+(format|')/i,
  /\b(AND|OR)\s+[\w".]+\s*(=|<>|<=|>=|<|>|\bIN\b|\bIS\b|\bLIKE\b|\bILIKE\b)/,
];
// Comparison / list operator immediately before an interpolated value.
const VALUE_POSITION = /(?:[\w"\].)]\s*(?:=|<>|!=|<=|>=)|\b(?:IN|ANY|LIKE|ILIKE|LIMIT|OFFSET|INTERVAL)\s*\(?)\s*'?$/;

export function looksLikeSql(text) {
  return SQL_SHAPE.some((re) => re.test(text));
}

export function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}

/** Formatting-insensitive form used for fingerprints (line breaks / spaces around punctuation ignored). */
export function normalizeForId(text) {
  return normalize(text).replace(/\s*([(),[\]{};])\s*/g, "$1");
}

export function fingerprint(path, context, expression, occurrence) {
  return createHash("sha256")
    .update(`${path}\n${context}\n${normalizeForId(expression)}\n#${occurrence}`)
    .digest("hex")
    .slice(0, 20);
}

/**
 * Assigns a fingerprint, numbering identical expressions in the same function
 * by order of appearance so duplicates stay distinct call sites.
 */
function makeIdAllocator(path) {
  const seen = new Map();
  const legacySeen = new Map();
  return (context, expression) => {
    const key = `${context}\n${normalizeForId(expression)}`;
    const occ = (seen.get(key) ?? 0) + 1;
    seen.set(key, occ);
    const out = { id: fingerprint(path, context, expression, occ) };
    if (process.env.RAW_SQL_LEGACY_IDS) {
      const lkey = `${context}\n${normalize(expression)}`;
      const locc = (legacySeen.get(lkey) ?? 0) + 1;
      legacySeen.set(lkey, locc);
      out.legacyId = createHash("sha256").update(`${path}\n${context}\n${normalize(expression)}\n#${locc}`).digest("hex").slice(0, 20);
    }
    return out;
  };
}

const NUMERIC_CALLS = new Set(["Number", "parseInt", "parseFloat", "Number.parseInt", "Number.parseFloat", "Date.now", "Math.round", "Math.floor", "Math.ceil", "Math.trunc", "Math.max", "Math.min", "Math.abs", "Math.random"]);
// Members that are numeric ONLY on a receiver of the right built-in type. The
// receiver must be proven (see knownCollection / knownDate): a request value or
// parsed JSON can carry `{ length: "1 OR 1=1" }`, and String#valueOf returns the
// string itself, so the member name alone proves nothing.
const COLLECTION_NUMERIC_METHODS = new Set(["push", "unshift", "indexOf", "lastIndexOf", "findIndex", "findLastIndex", "charCodeAt", "codePointAt", "localeCompare"]);
const DATE_NUMERIC_METHODS = new Set(["getTime", "getFullYear", "getMonth", "getDate", "getDay", "getHours", "getMinutes", "getSeconds", "getMilliseconds", "getUTCFullYear", "getUTCMonth", "getUTCDate", "getUTCDay", "getUTCHours", "getTimezoneOffset"]);
const NUMERIC_PROPS = new Set(["length", "size"]);
// Calls that always return a real Array or string, whatever their input.
const COLLECTION_FACTORIES = new Set(["Object.keys", "Object.values", "Object.entries", "Array.from", "Array.of", "String", "JSON.stringify"]);
const COLLECTION_RETURNING_METHODS = new Set(["filter", "map", "flatMap", "flat", "slice", "concat", "split", "keys", "values", "entries", "toSorted", "toReversed", "join", "trim", "toUpperCase", "toLowerCase", "padStart", "padEnd", "toString", "toFixed", "toISOString", "repeat", "replace", "replaceAll", "substring"]);
const ARITH = new Set([
  ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken, ts.SyntaxKind.BarToken,
  ts.SyntaxKind.AmpersandToken, ts.SyntaxKind.CaretToken, ts.SyntaxKind.LessThanLessThanToken,
  ts.SyntaxKind.GreaterThanGreaterThanToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
]);

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)))) {
    node = node.expression;
  }
  return node;
}

/** Per-file symbol facts needed by the proofs (const bindings, writes, loop counters). */
function collectFileFacts(ast) {
  const consts = new Map(); // name -> [initializer]
  const mutable = new Set(); // names declared with let/var or as parameters
  const written = new Set(); // names whose properties/elements are assigned or which are passed to mutators
  const numericCounters = new Set();
  const plusAssigned = new Set();
  const forOf = new Map(); // name -> [iterated expressions]
  const functions = new Map(); // name -> [function-like nodes]
  const pushes = new Map(); // name -> [pushed argument nodes]
  const nonPushWrites = new Set(); // names mutated other than by .push(...)
  function visit(node) {
    if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer) &&
      (node.initializer.flags & ts.NodeFlags.Const) !== 0) {
      const decl = node.initializer.declarations[0];
      if (decl && ts.isIdentifier(decl.name)) {
        const arr = forOf.get(decl.name.text) ?? [];
        arr.push(node.expression);
        forOf.set(decl.name.text, arr);
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const arr = functions.get(node.name.text) ?? [];
      arr.push(node);
      functions.set(node.name.text, arr);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer &&
      (ts.isArrowFunction(unwrap(node.initializer)) || ts.isFunctionExpression(unwrap(node.initializer))) &&
      ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      const arr = functions.get(node.name.text) ?? [];
      arr.push(unwrap(node.initializer));
      functions.set(node.name.text, arr);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (isConst && node.initializer) {
        const arr = consts.get(node.name.text) ?? [];
        arr.push(node.initializer);
        consts.set(node.name.text, arr);
      } else {
        mutable.add(node.name.text);
      }
      // for (let i = 0; ...; i++) numeric counters
      if (!isConst && list.parent && ts.isForStatement(list.parent) && node.initializer &&
        ts.isNumericLiteral(unwrap(node.initializer))) {
        numericCounters.add(node.name.text);
      }
    }
    if (ts.isParameter(node) && ts.isIdentifier(node.name)) mutable.add(node.name.text);
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name)) mutable.add(node.name.text);
    if (ts.isBinaryExpression(node)) {
      const k = node.operatorToken.kind;
      if (k >= ts.SyntaxKind.FirstAssignment && k <= ts.SyntaxKind.LastAssignment) {
        let target = unwrap(node.left);
        if (ts.isIdentifier(target) && k === ts.SyntaxKind.PlusEqualsToken) plusAssigned.add(target.text);
        if (ts.isIdentifier(target)) mutable.add(target.text);
        while (target && (ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target))) {
          target = unwrap(target.expression);
          if (ts.isIdentifier(target)) { written.add(target.text); nonPushWrites.add(target.text); }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ["push", "unshift", "splice", "set", "add", "fill", "sort", "reverse", "copyWithin", "assign", "defineProperty"].includes(callee.name.text)) {
        const recv = unwrap(callee.expression);
        if (ts.isIdentifier(recv) && !["Object", "Reflect"].includes(recv.text)) {
          written.add(recv.text);
          if (callee.name.text === "push") {
            const arr = pushes.get(recv.text) ?? [];
            arr.push(...node.arguments);
            pushes.set(recv.text, arr);
          } else nonPushWrites.add(recv.text);
        }
        if (ts.isIdentifier(recv) && ["Object", "Reflect"].includes(recv.text) && node.arguments[0]) {
          const t = unwrap(node.arguments[0]);
          if (ts.isIdentifier(t)) written.add(t.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return { consts, mutable, written, numericCounters, plusAssigned, forOf, functions, pushes, nonPushWrites };
}

export function createProver(ast, facts) {
  const text = (n) => n.getText(ast);
  const resolving = new Set();
  const assumed = []; // stack of Sets: parameter names proven at the current call site
  const isAssumed = (name) => assumed.some((set) => set.has(name));

  function constInitializers(name) {
    if (facts.mutable.has(name)) return null;
    const inits = facts.consts.get(name);
    return inits && inits.length ? inits : null;
  }

  function isNumeric(node) {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isNumericLiteral(node) || ts.isBigIntLiteral(node)) return true;
    if (ts.isPrefixUnaryExpression(node)) {
      if ([ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.TildeToken].includes(node.operator)) {
        return node.operator === ts.SyntaxKind.MinusToken ? isNumeric(node.operand) : true;
      }
    }
    if (ts.isPostfixUnaryExpression(node)) return true;
    if (ts.isBinaryExpression(node)) {
      if (ARITH.has(node.operatorToken.kind)) return true;
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return isNumeric(node.left) && isNumeric(node.right);
      if ([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) return isNumeric(node.left) && isNumeric(node.right);
    }
    if (ts.isConditionalExpression(node)) return isNumeric(node.whenTrue) && isNumeric(node.whenFalse);
    if (ts.isPropertyAccessExpression(node) && NUMERIC_PROPS.has(node.name.text)) return knownCollection(node.expression);
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      const name = text(callee);
      if (NUMERIC_CALLS.has(name) || /^Math\.\w+$/.test(name)) return true;
      if (ts.isPropertyAccessExpression(callee) && COLLECTION_NUMERIC_METHODS.has(callee.name.text)) return knownCollection(callee.expression);
      if (ts.isPropertyAccessExpression(callee) && DATE_NUMERIC_METHODS.has(callee.name.text)) return knownDate(callee.expression);
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "toFixed") return isNumeric(callee.expression);
      if (name === "String" && node.arguments.length === 1) return isNumeric(node.arguments[0]);
    }
    if (ts.isIdentifier(node)) {
      if (facts.numericCounters.has(node.text)) return true;
      const inits = constInitializers(node.text);
      if (inits && !resolving.has(node.text)) {
        resolving.add(node.text);
        try { return inits.every(isNumeric); } finally { resolving.delete(node.text); }
      }
    }
    return false;
  }

  /** Receiver is certainly a real Array / string / Map / Set built by this code. */
  function knownCollection(node, depth = 0) {
    node = unwrap(node);
    if (!node || depth > 8) return false;
    if (ts.isArrayLiteralExpression(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) return true;
    if (ts.isNewExpression(node) && ["Map", "Set", "Array"].includes(text(node.expression))) return true;
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (COLLECTION_FACTORIES.has(text(callee))) return true;
      if (ts.isPropertyAccessExpression(callee) && COLLECTION_RETURNING_METHODS.has(callee.name.text)) {
        // e.g. xs.filter(...), s.split(","): only when the receiver is itself known.
        return knownCollection(callee.expression, depth + 1);
      }
      return false;
    }
    if (ts.isIdentifier(node)) {
      if (facts.forOf.has(node.text) || resolving.has("col:" + node.text)) return false;
      const inits = constInitializers(node.text);
      if (!inits) return false;
      resolving.add("col:" + node.text);
      try { return inits.every((i) => knownCollection(i, depth + 1)); } finally { resolving.delete("col:" + node.text); }
    }
    return false;
  }

  /** Receiver is certainly a Date built by this code. */
  function knownDate(node, depth = 0) {
    node = unwrap(node);
    if (!node || depth > 8) return false;
    if (ts.isNewExpression(node) && text(node.expression) === "Date") return true;
    if (ts.isIdentifier(node)) {
      if (resolving.has("date:" + node.text)) return false;
      const inits = constInitializers(node.text);
      if (!inits) return false;
      resolving.add("date:" + node.text);
      try { return inits.every((i) => knownDate(i, depth + 1)); } finally { resolving.delete("date:" + node.text); }
    }
    return false;
  }

  function isStaticValueContainer(node) {
    node = unwrap(node);
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.every((p) =>
        (ts.isPropertyAssignment(p) && isStatic(p.initializer)) ||
        (ts.isShorthandPropertyAssignment(p) && isStatic(p.name)));
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => !ts.isSpreadElement(e) && isStatic(e));
    if (ts.isNewExpression(node) && ["Map", "Set"].includes(text(node.expression)) && node.arguments?.length === 1) {
      return isStaticValueContainer(node.arguments[0]);
    }
    if (ts.isCallExpression(node) && text(node.expression) === "Object.freeze" && node.arguments.length === 1) {
      return isStaticValueContainer(node.arguments[0]);
    }
    return false;
  }

  function containerIdentifier(node) {
    node = unwrap(node);
    if (!ts.isIdentifier(node)) return false;
    if (facts.written.has(node.text)) return false;
    const inits = constInitializers(node.text);
    if (!inits || resolving.has(node.text)) return false;
    resolving.add(node.text);
    try { return inits.every(isStaticValueContainer); } finally { resolving.delete(node.text); }
  }

  function isStatic(node) {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isNumericLiteral(node)) return true;
    if ([ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)) return true;
    if (ts.isIdentifier(node) && node.text === "undefined") return true;
    if (ts.isTemplateExpression(node)) return node.templateSpans.every((s) => isProven(s.expression));
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      // `a && "x"` yields a or "x"; a must itself be proven.
      return isProven(node.left) && isProven(node.right);
    }
    if (ts.isConditionalExpression(node)) return isProven(node.whenTrue) && isProven(node.whenFalse);
    if (ts.isIdentifier(node)) {
      if (isAssumed(node.text)) return true;
      const iterated = facts.forOf.get(node.text);
      if (iterated && !facts.consts.has(node.text) && !resolving.has(node.text)) {
        resolving.add(node.text);
        try {
          return iterated.every((e) => {
            const u = unwrap(e);
            return (ts.isArrayLiteralExpression(u) && isStaticValueContainer(u)) || containerIdentifier(u);
          });
        } finally { resolving.delete(node.text); }
      }
      const inits = constInitializers(node.text);
      if (!inits || resolving.has(node.text)) return false;
      resolving.add(node.text);
      try { return inits.every((i) => isProven(i)); } finally { resolving.delete(node.text); }
    }
    // Lookup into a never-written const container of static values.
    if (ts.isElementAccessExpression(node) || ts.isPropertyAccessExpression(node)) {
      let base = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
        // nested static containers: X.a.b
        return isStaticPath(node);
      }
      return containerIdentifier(base);
    }
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        const recv = unwrap(callee.expression);
        if (m === "join" && (node.arguments.length === 0 || isStatic(node.arguments[0]))) {
          if (ts.isArrayLiteralExpression(recv)) return recv.elements.every((e) => !ts.isSpreadElement(e) && isProven(e));
          if (containerIdentifier(recv)) return true;
          if (pushOnlyArray(recv)) return true;
        }
        if (["toUpperCase", "toLowerCase", "trim"].includes(m) && node.arguments.length === 0) return isStatic(recv);
        if (m === "toISOString" && node.arguments.length === 0) return true; // fixed [0-9T:.Z-] format
        if (m === "get" && containerIdentifier(recv)) return true; // const Map lookup
      }
      if (text(callee) === "String" && node.arguments.length === 1) return isProven(node.arguments[0]);
      // Call to an in-file function whose every return value is proven
      // independently of its arguments.
      if (ts.isIdentifier(callee) && functionReturnsProven(callee.text)) return true;
      if (ts.isIdentifier(callee) && node.arguments.every((a) => !ts.isSpreadElement(a) && isProven(a)) &&
        functionReturnsProven(callee.text, true)) return true;
    }
    return false;
  }

  function returnExpressions(fn) {
    if (!fn.body) return null;
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out = [];
    let bare = false;
    (function walk(n) {
      if (n !== fn && (ts.isFunctionLike(n))) return;
      if (ts.isReturnStatement(n)) { if (n.expression) out.push(n.expression); else bare = true; }
      ts.forEachChild(n, walk);
    })(fn.body);
    return bare && out.length === 0 ? null : out;
  }
  function functionReturnsProven(name, assumeParams = false) {
    const fns = facts.functions.get(name);
    const key = (assumeParams ? "fnp:" : "fn:") + name;
    if (!fns || facts.mutable.has(name) || resolving.has(key)) return false;
    resolving.add(key);
    try {
      return fns.every((fn) => {
        const rets = returnExpressions(fn);
        if (!rets || rets.length === 0) return false;
        const params = new Set(assumeParams
          ? fn.parameters.filter((p) => ts.isIdentifier(p.name) && !p.dotDotDotToken).map((p) => p.name.text)
          : []);
        if (assumeParams && params.size !== fn.parameters.length) return false;
        assumed.push(params);
        try { return rets.every((r) => isProven(r)); } finally { assumed.pop(); }
      });
    } finally { resolving.delete(key); }
  }

  /** `const xs = [proven...]` mutated only by `xs.push(proven...)`. */
  function pushOnlyArray(node) {
    node = unwrap(node);
    if (!ts.isIdentifier(node) || facts.nonPushWrites.has(node.text)) return false;
    const inits = constInitializers(node.text);
    if (!inits || resolving.has("arr:" + node.text)) return false;
    resolving.add("arr:" + node.text);
    try {
      return inits.every((i) => ts.isArrayLiteralExpression(unwrap(i)) && isStaticValueContainer(i)) &&
        (facts.pushes.get(node.text) ?? []).every((a) => !ts.isSpreadElement(a) && isProven(a));
    } finally { resolving.delete("arr:" + node.text); }
  }

  function isStaticPath(node) {
    let base = node;
    while (ts.isPropertyAccessExpression(unwrap(base)) || ts.isElementAccessExpression(unwrap(base))) base = unwrap(base).expression;
    return containerIdentifierDeep(unwrap(base));
  }
  function deepStatic(node) {
    node = unwrap(node);
    if (ts.isObjectLiteralExpression(node)) return node.properties.every((p) => ts.isPropertyAssignment(p) && deepStatic(p.initializer));
    if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => !ts.isSpreadElement(e) && deepStatic(e));
    return isStatic(node);
  }
  function containerIdentifierDeep(node) {
    if (!ts.isIdentifier(node) || facts.written.has(node.text)) return false;
    const inits = constInitializers(node.text);
    if (!inits || resolving.has(node.text)) return false;
    resolving.add(node.text);
    try { return inits.every(deepStatic); } finally { resolving.delete(node.text); }
  }

  function isProven(node) {
    return isStatic(node) || isNumeric(node);
  }

  /** Leaf dynamic parts of a text-producing expression that are NOT proven. */
  function unprovenParts(node, out = [], depth = 0) {
    node = unwrap(node);
    if (!node || depth > 12) return out;
    if (isProven(node)) return out;
    if (ts.isTemplateExpression(node)) {
      for (const s of node.templateSpans) unprovenParts(s.expression, out, depth + 1);
      return out;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      unprovenParts(node.left, out, depth + 1);
      unprovenParts(node.right, out, depth + 1);
      return out;
    }
    if (ts.isConditionalExpression(node)) {
      unprovenParts(node.whenTrue, out, depth + 1);
      unprovenParts(node.whenFalse, out, depth + 1);
      return out;
    }
    out.push(node);
    return out;
  }

  return { isStatic, isNumeric, isProven, unprovenParts, constInitializers };
}

/** Static text of a template / concatenation, with dynamic parts replaced by a marker. */
export function staticText(node, ast) {
  node = unwrap(node);
  if (!node) return "";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let s = node.head.text;
    for (const span of node.templateSpans) s += staticText(span.expression, ast) + span.literal.text;
    return s;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return staticText(node.left, ast) + staticText(node.right, ast);
  }
  if (ts.isConditionalExpression(node)) return staticText(node.whenTrue, ast) + " " + staticText(node.whenFalse, ast);
  return " \u0000 ";
}

function isTextExpression(node) {
  node = unwrap(node);
  return !!node && (ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken));
}

function enclosingContext(node, ast) {
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) && p.name) names.unshift(p.name.getText(ast));
    else if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isVariableDeclaration(p.parent)) names.unshift(p.parent.name.getText(ast));
    else if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) names.unshift(p.name.getText(ast));
  }
  return names.join(".") || "<module>";
}

/** drizzle `sql` import aliases in this file (always includes the bare name `sql`). */
function sqlAliases(ast) {
  const names = new Set(["sql"]);
  for (const stmt of ast.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text.startsWith("drizzle-orm") && stmt.importClause?.namedBindings &&
      ts.isNamedImports(stmt.importClause.namedBindings)) {
      for (const el of stmt.importClause.namedBindings.elements) {
        if ((el.propertyName ?? el.name).text === "sql") names.add(el.name.text);
      }
    }
  }
  return names;
}

const PLPGSQL_EXECUTE = /\bEXECUTE\s+(?!FUNCTION\b|PROCEDURE\b|ON\b)((?:format\s*\(|'|[a-z_][\w.]*\s*(?:;|\|\||\bUSING\b|\bINTO\b))[\s\S]*?)(?:;|$)/gi;

/** Classify one PL/pgSQL EXECUTE statement text. Returns null when it is provably quoted/static. */
export function classifyPlpgsqlExecute(body) {
  const trimmed = body.trim();
  // EXECUTE 'static text' [USING ...]
  if (/^'(?:[^']|'')*'\s*((USING|INTO)\b[\s\S]*)?$/i.test(trimmed)) return null;
  const fmt = /^format\s*\(\s*'((?:[^']|'')*)'/i.exec(trimmed);
  if (fmt) {
    const unsafe = (fmt[1].match(/%(?:\d+\$)?[-]?s/g) ?? []);
    const afterFormat = trimmed.slice(fmt[0].length);
    if (unsafe.length === 0 && !/\|\|/.test(afterFormat.replace(/'(?:[^']|'')*'/g, "''"))) return null;
    return "format() uses %s (unquoted) placeholder";
  }
  return "EXECUTE of a non-literal / concatenated string";
}

export function scanSqlFile(path, source) {
  const findings = [];
  const allocate = makeIdAllocator(path);
  for (const m of source.matchAll(PLPGSQL_EXECUTE)) {
    const reason = classifyPlpgsqlExecute(m[1]);
    const line = source.slice(0, m.index).split("\n").length;
    const expression = m[0].slice(0, 400);
    findings.push({
      ...allocate("<sql>", expression), path, line, kind: "plpgsql-execute",
      context: "<sql>", sink: "PL/pgSQL EXECUTE", expression: normalize(expression).slice(0, 300),
      dynamicParts: reason ? [normalize(m[1]).slice(0, 200)] : [],
      autoVerified: reason ? null : "plpgsql-quoted-format",
      note: reason ?? "format() with only %I/%L placeholders or a literal string",
    });
  }
  return findings;
}

export function scanSource(path, source) {
  if (path.endsWith(".sql")) return scanSqlFile(path, source);
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const facts = collectFileFacts(ast);
  const prover = createProver(ast, facts);
  const aliases = sqlAliases(ast);
  const findings = [];
  const allocate = makeIdAllocator(path);
  const reported = new Set(); // nodes already reported (avoid double counting nested text)
  const text = (n) => n.getText(ast);

  function report(node, kind, sink, parts, extra = {}) {
    const context = enclosingContext(node, ast);
    const expression = text(node);
    const unproven = parts.map((p) => normalize(text(p)));
    let autoVerified = null;
    if (unproven.length === 0) autoVerified = extra.autoReason ?? "static";
    findings.push({
      ...allocate(context, expression),
      path,
      line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
      kind,
      context,
      sink,
      expression: normalize(expression).slice(0, 300),
      dynamicParts: [...new Set(unproven)],
      autoVerified,
      ...(extra.note ? { note: extra.note } : {}),
    });
  }

  function markReported(node) {
    node = unwrap(node);
    reported.add(node);
    if (ts.isBinaryExpression(node)) { markReported(node.left); markReported(node.right); }
    if (ts.isConditionalExpression(node)) { markReported(node.whenTrue); markReported(node.whenFalse); }
  }

  function sinkName(call) {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee) && SINK_METHODS.has(callee.name.text)) {
      return `${text(callee.expression).slice(0, 60)}.${callee.name.text}`;
    }
    return null;
  }

  // Embedded PL/pgSQL EXECUTE inside string literals / templates.
  function scanEmbeddedPlpgsql(node) {
    const raw = ts.isTemplateExpression(node) ? staticText(node, ast) : node.text;
    if (!/\bEXECUTE\b/i.test(raw)) return;
    for (const m of raw.matchAll(PLPGSQL_EXECUTE)) {
      const reason = classifyPlpgsqlExecute(m[1].replace(/\u0000/g, "x"));
      if (!reason) continue;
      const expression = m[0].slice(0, 300);
      const context = enclosingContext(node, ast);
      findings.push({
        ...allocate(context, "EXECUTE " + expression), path,
        line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        kind: "plpgsql-execute", context, sink: "PL/pgSQL EXECUTE (embedded)",
        expression: normalize(expression), dynamicParts: [normalize(m[1]).slice(0, 200)], autoVerified: null, note: reason,
      });
    }
  }

  function visitCalls(node) {
    if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      // sql.raw / sql.identifier
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && aliases.has(callee.expression.text)) {
        const method = callee.name.text;
        if (method === "raw") {
          const arg = node.arguments[0];
          report(node, "sql.raw", "drizzle sql.raw", arg ? prover.unprovenParts(arg) : []);
          if (arg) markReported(arg);
        } else if (method === "identifier") {
          const parts = node.arguments.flatMap((a) => prover.unprovenParts(a));
          if (parts.length || node.arguments.length !== 1) {
            report(node, "dynamic-identifier", "drizzle sql.identifier", parts,
              node.arguments.length !== 1 ? { note: "sql.identifier takes exactly one argument" } : {});
          }
        }
      }
      const sink = sinkName(node);
      if (sink && node.arguments.length) {
        const arg = unwrap(node.arguments[0]);
        if (isTextExpression(arg)) {
          report(node, "query-text", sink, prover.unprovenParts(arg));
          markReported(arg);
        } else if (ts.isIdentifier(arg) && !aliases.has(arg.text)) {
          const inits = facts.consts.get(arg.text) ?? [];
          const textInits = inits.filter(isTextExpression);
          if (facts.plusAssigned.has(arg.text) || (facts.mutable.has(arg.text) && !inits.length)) {
            report(node, "indirect-query-text", sink, [arg], { note: "query text held in a mutable variable / parameter" });
          } else if (textInits.length) {
            report(node, "indirect-query-text", sink, textInits.flatMap((i) => prover.unprovenParts(i)));
            textInits.forEach(markReported);
          }
        }
      }
      // .replace on SQL text
      if (ts.isPropertyAccessExpression(callee) && ["replace", "replaceAll"].includes(callee.name.text) && node.arguments.length === 2) {
        const recvText = staticText(callee.expression, ast);
        if (looksLikeSql(recvText) && !prover.isProven(node.arguments[1])) {
          report(node, "sql-text-replace", "string replace", prover.unprovenParts(node.arguments[1]));
        }
      }
      // [ "...SQL...", x ].join()
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join" && ts.isArrayLiteralExpression(unwrap(callee.expression))) {
        const arr = unwrap(callee.expression);
        const st = arr.elements.map((e) => staticText(e, ast)).join(" ");
        if (looksLikeSql(st)) {
          const parts = arr.elements.flatMap((e) => ts.isSpreadElement(e) ? [e] : prover.unprovenParts(e));
          if (parts.length) report(node, "sql-array-join", "array join", parts);
          arr.elements.forEach(markReported);
        }
      }
    }
    ts.forEachChild(node, visitCalls);
  }
  function visitText(node) {
    if ((ts.isTemplateExpression(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      scanEmbeddedPlpgsql(node);
    }
    if (isTextExpression(node) && !reported.has(node) && !(node.parent && ts.isTaggedTemplateExpression(node.parent))) {
      const st = staticText(node, ast);
      const parts = prover.unprovenParts(node);
      const quoteWrapped = ts.isTemplateExpression(node) && node.templateSpans.some((s, i) => {
        const before = i === 0 ? node.head.text : node.templateSpans[i - 1].literal.text;
        return /'$/.test(before) && /^'/.test(s.literal.text) && /(?:=|<|>|\b(?:AND|OR|IN|LIKE|ILIKE|VALUES|SET|WHERE)\b)\s*'?$/i.test(before.replace(/'$/, ""));
      });
      const sqlShaped = looksLikeSql(st) || quoteWrapped || (ts.isTemplateExpression(node) && node.templateSpans.some((s, i) => {
        const before = i === 0 ? node.head.text : node.templateSpans[i - 1].literal.text;
        return VALUE_POSITION.test(before) && /[A-Za-z_]/.test(before) && /^[\w"'.]*\s*[=<>]|\b(AND|OR|FROM|WHERE|SELECT)\b/.test(before + " " + s.literal.text);
      }));
      const hasDynamic = ts.isTemplateExpression(node) || staticText(node, ast).includes("\u0000");
      if (sqlShaped && hasDynamic) {
        report(node, "assembled-sql-text", "string assembly", parts);
        markReported(node);
      }
    }
    ts.forEachChild(node, visitText);
  }
  visitCalls(ast);
  visitText(ast);
  findings.sort((a, b) => a.line - b.line);
  return findings;
}
