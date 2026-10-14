const FULLY_SENSITIVE_KEY_PATTERN =
  /(?:password|passwd|secret|token|authorization|cookie|session|csrf|api[-_]?key|private[-_]?key|credential)/i;
const PHONE_KEY_PATTERN = /(?:phone|mobile|msisdn|whatsapp|chat[-_]?id|recipient)/i;
const EMAIL_KEY_PATTERN = /email/i;
const URL_KEY_PATTERN = /(?:url|uri|link|download|upload)/i;
const PRIVATE_FILE_URL_PATTERN = /(?:green-api|storage|signed|presigned|private|attachment)/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const AUTH_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=:-]+/gi;
const WHATSAPP_GROUP_PATTERN = /\b(\d{6,})-\d+@g\.us\b/gi;
const WHATSAPP_CONTACT_PATTERN = /\b(\d{7,})@c\.us\b/gi;
const QUERY_SECRET_PATTERN = /([?&](?:access_token|token|api_key|apikey|key|signature|sig|secret|auth)=)[^&#\s]+/gi;
const CONNECTION_STRING_PATTERN = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi;
const INLINE_SECRET_ASSIGNMENT_PATTERN = /\b(expected|got)=([A-Fa-f0-9]{8,})(?:…|\.\.\.)?/g;

function maskTail(value: string, label: string): string {
  const digits = value.replace(/\D/g, "");
  const tail = digits.slice(-4) || "hidden";
  return `${label} …${tail}`;
}

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    for (const key of [...parsed.searchParams.keys()]) {
      if (FULLY_SENSITIVE_KEY_PATTERN.test(key) || /(?:signature|sig|auth|key)/i.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    if (PRIVATE_FILE_URL_PATTERN.test(parsed.hostname) || PRIVATE_FILE_URL_PATTERN.test(parsed.pathname)) {
      const fileName = parsed.pathname.split("/").filter(Boolean).pop();
      return fileName ? `[PRIVATE_URL:${fileName}]` : "[PRIVATE_URL]";
    }
    return parsed.toString();
  } catch {
    return value.replace(QUERY_SECRET_PATTERN, "$1[REDACTED]");
  }
}

export function redactLogString(value: string, key = ""): string {
  if (FULLY_SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";

  let output = value
    .replace(AUTH_PATTERN, "[AUTH_REDACTED]")
    .replace(JWT_PATTERN, "[JWT_REDACTED]")
    .replace(CONNECTION_STRING_PATTERN, "[CONNECTION_STRING_REDACTED]")
    .replace(QUERY_SECRET_PATTERN, "$1[REDACTED]")
    .replace(INLINE_SECRET_ASSIGNMENT_PATTERN, "$1=[REDACTED]")
    .replace(WHATSAPP_GROUP_PATTERN, (_, digits: string) => maskTail(digits, "WhatsApp group"))
    .replace(WHATSAPP_CONTACT_PATTERN, (_, digits: string) => maskTail(digits, "WhatsApp contact"));

  if (URL_KEY_PATTERN.test(key) || /^https?:\/\//i.test(output)) output = redactUrl(output);
  if (PHONE_KEY_PATTERN.test(key) && /\d{7,}/.test(output)) return maskTail(output, "contact");
  if (EMAIL_KEY_PATTERN.test(key)) {
    output = output.replace(
      /\b([A-Z0-9._%+-]{1,})@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
      (_, local: string, domain: string) => {
        const visible = local.slice(0, 1) || "x";
        return `${visible}***@${domain}`;
      }
    );
  }
  return output;
}

export function redactLogValue(value: unknown, key = ""): unknown {
  if (FULLY_SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactLogString(value, key);
  return value;
}
