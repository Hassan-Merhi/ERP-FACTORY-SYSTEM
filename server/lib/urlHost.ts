/**
 * Hostname matching for URLs. Substring checks such as `url.includes("example.com")`
 * also match `example.com.evil.net` or `evil.net/?example.com`, so compare the
 * parsed hostname against the domain or one of its subdomains instead.
 */
export function hostnameMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const target = domain.toLowerCase();
  return host === target || host.endsWith(`.${target}`);
}

export function urlHostMatches(url: string, domain: string): boolean {
  try {
    return hostnameMatches(new URL(url).hostname, domain);
  } catch {
    return false;
  }
}
