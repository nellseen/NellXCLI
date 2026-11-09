import pino from "pino";

const secretPaths = [
  "apiKey",
  "api_key",
  "authorization",
  "headers.authorization",
  "secret",
  "token",
  "*.apiKey",
  "*.api_key",
  "*.authorization",
  "*.secret",
  "*.token",
];

export const logger = pino({
  level: process.env.NELLX_LOG_LEVEL ?? "info",
  redact: {
    paths: secretPaths,
    censor: "[REDACTED]",
  },
});
