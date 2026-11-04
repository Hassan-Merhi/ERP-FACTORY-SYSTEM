/*
 * Based on deepmerge 4.3.1 (MIT). See LICENSE.
 *
 * Security hardening for GHSA-gcqx-w48m-w2h4:
 * Block prototype-mutating keys in BOTH source and target input objects,
 * including nested merge branches. Preserve the deepmerge 4.x API for the
 * Puppeteer Extra plugins that use it.
 */
"use strict";
const defaultIsMergeableObject = require("is-mergeable-object");
const hasOwn = Object.prototype.hasOwnProperty;
const isEnumerable = Object.prototype.propertyIsEnumerable;
const DENIED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key) {
  return typeof key !== "string" || !DENIED_KEYS.has(key);
}
function emptyTarget(value) {
  return Array.isArray(value) ? [] : {};
}
function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value)
    ? deepmerge(emptyTarget(value), value, options)
    : value;
}
function defaultArrayMerge(target, source, options) {
  return target.concat(source).map((item) => cloneUnlessOtherwiseSpecified(item, options));
}
function getMergeFunction(key, options) {
  if (!options.customMerge) return deepmerge;
  const custom = options.customMerge(key);
  return typeof custom === "function" ? custom : deepmerge;
}
function ownEnumerableKeys(target) {
  if (target == null) return [];
  const keys = Object.keys(target);
  if (typeof Object.getOwnPropertySymbols === "function") {
    keys.push(...Object.getOwnPropertySymbols(target).filter((key) => isEnumerable.call(target, key)));
  }
  return keys.filter(isSafeKey);
}
function propertyIsOnObject(object, key) {
  try {
    return key in object;
  } catch {
    return false;
  }
}
function propertyIsUnsafe(target, key) {
  return !isSafeKey(key) ||
    (propertyIsOnObject(target, key) && !(hasOwn.call(target, key) && isEnumerable.call(target, key)));
}
function mergeObject(target, source, options) {
  const destination = {};
  if (options.isMergeableObject(target)) {
    ownEnumerableKeys(target).forEach((key) => {
      // Only safe own keys may be copied. A hostile target can contain an
      // own "__proto__" data property created by JSON.parse or defineProperty.
      if (!propertyIsUnsafe({}, key)) {
        Object.defineProperty(destination, key, {
          value: cloneUnlessOtherwiseSpecified(target[key], options),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    });
  }
  ownEnumerableKeys(source).forEach((key) => {
    if (propertyIsUnsafe(target, key)) return;
    const value = propertyIsOnObject(target, key) && options.isMergeableObject(source[key])
      ? getMergeFunction(key, options)(target[key], source[key], options)
      : cloneUnlessOtherwiseSpecified(source[key], options);
    Object.defineProperty(destination, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });
  return destination;
}
function deepmerge(target, source, options) {
  options = options || {};
  options.arrayMerge = options.arrayMerge || defaultArrayMerge;
  options.isMergeableObject = options.isMergeableObject || defaultIsMergeableObject;
  options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
  const sourceIsArray = Array.isArray(source);
  if (sourceIsArray !== Array.isArray(target)) {
    return cloneUnlessOtherwiseSpecified(source, options);
  }
  return sourceIsArray ? options.arrayMerge(target, source, options) : mergeObject(target, source, options);
}
deepmerge.all = function deepmergeAll(array, options) {
  if (!Array.isArray(array)) throw new Error("first argument should be an array");
  return array.reduce((value, part) => deepmerge(value, part, options), {});
};
module.exports = deepmerge;
