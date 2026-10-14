import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isRecord } from "@shared/typeGuards";

const FILTER_STATE_VERSION = 1;

export type FilterStateAction<T> = T | ((current: T) => T);

interface StoredFilterState {
  version: number;
  filters: unknown;
}

export interface UsePaginatedFilterStateOptions<T extends Record<string, unknown>> {
  createInitialFilters: () => T;
  storageKey?: string;
  initialPage?: number;
}

function restoreMatchingShape<T>(candidate: unknown, defaults: T): T {
  if (Array.isArray(defaults)) {
    return (Array.isArray(candidate) ? candidate : defaults) as T;
  }

  if (isRecord(defaults)) {
    if (!isRecord(candidate)) return defaults;
    const restored: Record<string, unknown> = {};
    for (const [key, defaultValue] of Object.entries(defaults)) {
      restored[key] = restoreMatchingShape(candidate[key], defaultValue);
    }
    return restored as T;
  }

  return (typeof candidate === typeof defaults ? candidate : defaults) as T;
}

export function readPersistedFilters<T extends Record<string, unknown>>(
  storageKey: string | undefined,
  defaults: T
): T {
  if (!storageKey || typeof sessionStorage === "undefined") return defaults;

  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw) return defaults;
    const stored = JSON.parse(raw) as StoredFilterState;
    if (stored.version !== FILTER_STATE_VERSION) return defaults;
    return restoreMatchingShape(stored.filters, defaults);
  } catch {
    return defaults;
  }
}

export function persistFilters<T extends Record<string, unknown>>(storageKey: string | undefined, filters: T): void {
  if (!storageKey || typeof sessionStorage === "undefined") return;

  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        version: FILTER_STATE_VERSION,
        filters,
      } satisfies StoredFilterState)
    );
  } catch {
    // Storage can be unavailable in private browsing or constrained webviews.
  }
}

export function usePaginatedFilterState<T extends Record<string, unknown>>({
  createInitialFilters,
  storageKey,
  initialPage = 1,
}: UsePaginatedFilterStateOptions<T>) {
  const defaultsRef = useRef<T | null>(null);
  if (!defaultsRef.current) defaultsRef.current = createInitialFilters();
  const defaults = defaultsRef.current;

  const [activeStorageKey, setActiveStorageKey] = useState(storageKey);
  const [filters, setFiltersState] = useState<T>(() => readPersistedFilters(storageKey, defaults));
  const [page, setPage] = useState(initialPage);

  useEffect(() => {
    if (storageKey === activeStorageKey) return;
    setFiltersState(readPersistedFilters(storageKey, defaults));
    setPage(initialPage);
    setActiveStorageKey(storageKey);
  }, [activeStorageKey, defaults, initialPage, storageKey]);

  useEffect(() => {
    if (storageKey !== activeStorageKey) return;
    persistFilters(storageKey, filters);
  }, [activeStorageKey, filters, storageKey]);

  const setFilters = useCallback(
    (next: FilterStateAction<T>) => {
      setFiltersState((current) => (typeof next === "function" ? (next as (value: T) => T)(current) : next));
      setPage(initialPage);
    },
    [initialPage]
  );

  const updateFilters = useCallback(
    (next: Partial<T> | ((current: T) => Partial<T>)) => {
      setFiltersState((current) => ({
        ...current,
        ...(typeof next === "function" ? next(current) : next),
      }));
      setPage(initialPage);
    },
    [initialPage]
  );

  const setFilter = useCallback(
    <K extends keyof T>(key: K, next: FilterStateAction<T[K]>) => {
      setFiltersState((current) => ({
        ...current,
        [key]: typeof next === "function" ? (next as (value: T[K]) => T[K])(current[key]) : next,
      }));
      setPage(initialPage);
    },
    [initialPage]
  );

  const resetFilters = useCallback(() => {
    setFiltersState(defaults);
    setPage(initialPage);
  }, [defaults, initialPage]);

  const hasActiveFilters = useMemo(() => JSON.stringify(filters) !== JSON.stringify(defaults), [defaults, filters]);

  return {
    filters,
    page,
    setPage,
    setFilter,
    setFilters,
    updateFilters,
    resetFilters,
    hasActiveFilters,
  };
}
