const isProduction = process.env.NODE_ENV === "production";

function parseBoundedInteger(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    const message = `${name} must be an integer between ${min} and ${max}`;
    if (isProduction) throw new Error(message);
    console.warn(`[SecurityRuntimeConfig] ${message}; using ${fallback}`);
    return fallback;
  }
  return value;
}

const allowedMethods = Object.freeze([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export const securityRuntimeConfig = Object.freeze({
  isProduction,
  allowedMethods,
  maxRequestTargetBytes: parseBoundedInteger("MAX_REQUEST_TARGET_BYTES", 8192, 1024, 32768),
  maxHeaderCount: parseBoundedInteger("MAX_REQUEST_HEADER_COUNT", 100, 20, 250),
  permittedCapacitorOrigins: Object.freeze([
    "capacitor://localhost",
    "ionic://localhost",
    "https://localhost",
    "http://localhost",
  ]),
  responseHeaders: Object.freeze({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // Workers scan factory and retail barcodes using getUserMedia on our own HTTPS origin.
    // Deny microphone and geolocation; never allow third-party frames camera access.
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  }),
});

console.log("[SecurityRuntimeConfig] policy accepted", {
  environment: isProduction ? "production" : process.env.NODE_ENV || "development",
  maxRequestTargetBytes: securityRuntimeConfig.maxRequestTargetBytes,
  maxHeaderCount: securityRuntimeConfig.maxHeaderCount,
  allowedMethodCount: allowedMethods.length,
});
