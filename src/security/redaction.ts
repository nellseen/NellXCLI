const sensitivePropertyNames = new Set([
  "apikey",
  "googleapikey",
  "authorization",
  "password",
  "secret",
  "token",
  "credential",
  "credentialvalue",
]);

export function redactSensitiveData(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveData);
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replaceAll(/[-_]/g, "");
    result[key] =
      sensitivePropertyNames.has(normalizedKey) ||
      normalizedKey.includes("apikey")
        ? "[REDACTED]"
        : redactSensitiveData(item);
  }
  return result;
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED_API_KEY]")
    .replace(
      /((?:api[\s_-]?key|authorization|password|secret|token)\s*[:=]\s*)([^\s,;]+)/gi,
      "$1[REDACTED]",
    );
}
