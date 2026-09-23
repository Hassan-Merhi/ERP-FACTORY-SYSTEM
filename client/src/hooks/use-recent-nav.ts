import { useState, useEffect, useMemo } from "react";
import { useLocation } from "wouter";

export interface RecentNavEntry {
  url: string;
  title: string;
  visitedAt: number;
}

const MAX_ITEMS = 5;

function storageKey(companyId: number | undefined) {
  return companyId ? `recent-nav-v1-company-${companyId}` : "recent-nav-v1-global";
}

export function canonicalNavigationPath(url: string): string {
  const queryIndex = url.indexOf("?");
  const hashIndex = url.indexOf("#");
  const cutAt = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  const normalized = cutAt === undefined ? url : url.slice(0, cutAt);
  return normalized || "/";
}

function loadFromStorage(companyId: number | undefined): RecentNavEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(companyId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToStorage(entries: RecentNavEntry[], companyId: number | undefined) {
  try {
    localStorage.setItem(storageKey(companyId), JSON.stringify(entries));
  } catch {
    // Storage is unavailable in private mode and can throw on quota; the value is a convenience, not state we need.
  }
}

interface NavItemLike {
  url: string;
  title: string;
}

function sameEntries(a: RecentNavEntry[], b: RecentNavEntry[]): boolean {
  return a.length === b.length && a.every((entry, index) => {
    const other = b[index];
    return other && entry.url === other.url && entry.title === other.title && entry.visitedAt === other.visitedAt;
  });
}

export function useRecentNav(
  allNavItems: NavItemLike[],
  companyId?: number,
  isAllowed?: (item: NavItemLike) => boolean,
) {
  const [location] = useLocation();
  const [recent, setRecent] = useState<RecentNavEntry[]>(() => loadFromStorage(companyId));

  const navByPath = useMemo(() => {
    const map = new Map<string, NavItemLike>();
    for (const item of allNavItems) {
      map.set(canonicalNavigationPath(item.url), item);
    }
    return map;
  }, [allNavItems]);

  // Sidebar visibility callbacks are commonly recreated on render. Depend on
  // their result, not their function identity, so permission filtering cannot
  // cause a render/effect loop.
  const allowedPathsKey = allNavItems
    .filter((item) => !isAllowed || isAllowed(item))
    .map((item) => canonicalNavigationPath(item.url))
    .sort()
    .join("\u0000");

  const allowedNavByPath = useMemo(() => {
    const map = new Map<string, NavItemLike>();
    for (const item of allNavItems) {
      const path = canonicalNavigationPath(item.url);
      if (allowedPathsKey.split("\u0000").includes(path)) map.set(path, item);
    }
    return map;
  }, [allNavItems, allowedPathsKey]);

  const sanitize = (entries: RecentNavEntry[]): RecentNavEntry[] => {
    const seen = new Set<string>();
    const next: RecentNavEntry[] = [];

    for (const entry of entries) {
      const item = allowedNavByPath.get(canonicalNavigationPath(entry.url));
      if (!item) continue;

      const canonicalUrl = item.url;
      if (seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      next.push({ url: canonicalUrl, title: item.title, visitedAt: entry.visitedAt });
      if (next.length >= MAX_ITEMS) break;
    }

    return next;
  };

  useEffect(() => {
    const loaded = sanitize(loadFromStorage(companyId));
    setRecent(loaded);
    saveToStorage(loaded, companyId);
  }, [companyId, allowedNavByPath]);

  useEffect(() => {
    setRecent((previous) => {
      const cleaned = sanitize(previous);
      if (sameEntries(previous, cleaned)) return previous;
      saveToStorage(cleaned, companyId);
      return cleaned;
    });
  }, [allowedNavByPath, companyId]);

  useEffect(() => {
    const item = allowedNavByPath.get(canonicalNavigationPath(location));
    if (!item) return;

    setRecent((previous) => {
      const cleaned = sanitize(previous).filter((entry) => entry.url !== item.url);
      const next = [{ url: item.url, title: item.title, visitedAt: Date.now() }, ...cleaned].slice(0, MAX_ITEMS);
      saveToStorage(next, companyId);
      return next;
    });
  }, [location, allowedNavByPath, companyId]);

  return recent;
}
