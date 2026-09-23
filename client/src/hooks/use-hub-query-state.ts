import { useCallback, useEffect, useState } from "react";

type HubQueryStateOptions<T extends string> = {
  key: "section" | "tab";
  allowedValues: readonly T[];
  /**
   * All values understood by this hub, including values currently restricted.
   * This lets the hook scrub stale legacy hashes such as #pending even when
   * "pending" is no longer in allowedValues.
   */
  knownValues?: readonly T[];
  defaultValue: T;
  clearKeys?: readonly string[];
  omitDefault?: boolean;
};

function fallbackValue<T extends string>(allowedValues: readonly T[], defaultValue: T): T {
  if (allowedValues.includes(defaultValue)) return defaultValue;
  return allowedValues[0] ?? defaultValue;
}

function readLegacyHash<T extends string>(
  url: URL,
  key: "section" | "tab",
  knownValues: readonly T[],
): T | null {
  if (!url.hash) return null;

  const rawHash = decodeURIComponent(url.hash.slice(1));
  if (!rawHash || rawHash === "main-content") return null;

  if (knownValues.includes(rawHash as T)) return rawHash as T;

  const hashParams = new URLSearchParams(rawHash);
  const keyedValue = hashParams.get(key);
  return keyedValue && knownValues.includes(keyedValue as T) ? (keyedValue as T) : null;
}

function replaceBrowserUrl(url: URL) {
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function canonicalizeHubLocation<T extends string>(options: HubQueryStateOptions<T>): T {
  const fallback = fallbackValue(options.allowedValues, options.defaultValue);
  if (typeof window === "undefined") return fallback;

  const url = new URL(window.location.href);
  const knownValues = options.knownValues ?? options.allowedValues;
  const rawQueryValue = url.searchParams.get(options.key);
  const legacyHashValue = readLegacyHash(url, options.key, knownValues);
  const requestedValue = rawQueryValue ?? legacyHashValue;

  const requestedAllowed =
    requestedValue !== null && options.allowedValues.includes(requestedValue as T);
  const nextValue = requestedAllowed ? (requestedValue as T) : fallback;
  let changed = false;

  if (options.allowedValues.length === 0) {
    if (url.searchParams.has(options.key)) {
      url.searchParams.delete(options.key);
      changed = true;
    }
  } else {
    const omit = options.omitDefault && nextValue === options.defaultValue;
    if (omit) {
      if (url.searchParams.has(options.key)) {
        url.searchParams.delete(options.key);
        changed = true;
      }
    } else if (url.searchParams.get(options.key) !== nextValue) {
      url.searchParams.set(options.key, nextValue);
      changed = true;
    }
  }

  // Hash-based tab navigation is legacy. Once recognized, remove it so it
  // cannot compete with the permission-filtered query state.
  if (legacyHashValue !== null) {
    url.hash = "";
    changed = true;
  }

  if (changed) replaceBrowserUrl(url);
  return nextValue;
}

export function useHubQueryState<T extends string>(options: HubQueryStateOptions<T>) {
  const {
    key,
    allowedValues,
    knownValues = allowedValues,
    defaultValue,
    clearKeys = [],
    omitDefault = false,
  } = options;

  const allowedValuesKey = allowedValues.join("\u0000");
  const knownValuesKey = knownValues.join("\u0000");
  const clearKeysKey = clearKeys.join("\u0000");

  const [value, setValue] = useState<T>(() =>
    canonicalizeHubLocation({ key, allowedValues, knownValues, defaultValue, clearKeys, omitDefault }),
  );

  useEffect(() => {
    const syncFromLocation = () =>
      setValue(canonicalizeHubLocation({ key, allowedValues, knownValues, defaultValue, clearKeys, omitDefault }));

    syncFromLocation();
    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener("hashchange", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener("hashchange", syncFromLocation);
    };
  }, [key, defaultValue, allowedValuesKey, knownValuesKey, clearKeysKey, omitDefault]);

  const updateValue = useCallback(
    (nextValue: T) => {
      if (!allowedValues.includes(nextValue)) {
        // Programmatic callers cannot select a value the current user cannot see.
        setValue(fallbackValue(allowedValues, defaultValue));
        return;
      }

      setValue(nextValue);

      const url = new URL(window.location.href);
      if (omitDefault && nextValue === defaultValue) {
        url.searchParams.delete(key);
      } else {
        url.searchParams.set(key, nextValue);
      }

      for (const clearKey of clearKeys) {
        url.searchParams.delete(clearKey);
      }

      // Once a hub uses canonical query state, discard any recognized legacy
      // tab/section hash so a stale hash cannot reopen a restricted child.
      if (readLegacyHash(url, key, knownValues) !== null) {
        url.hash = "";
      }

      replaceBrowserUrl(url);
    },
    [key, allowedValuesKey, knownValuesKey, defaultValue, clearKeysKey, omitDefault],
  );

  return [value, updateValue] as const;
}
