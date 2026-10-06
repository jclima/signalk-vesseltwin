/** Redaction helpers. Anything that could carry a secret goes through here before logging. */

const CREDENTIAL = /vti_[A-Za-z0-9_-]{8,}/g;
const BEARER = /(authorization["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"',}]+/gi;
const DEVICE_CODE = /(device_?code["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]{8,}/gi;

export function redact(text: string): string {
  return text
    .replace(BEARER, '$1[redacted]')
    .replace(DEVICE_CODE, '$1[redacted]')
    .replace(CREDENTIAL, 'vti_[redacted]');
}

export function redactError(err: unknown): string {
  if (err instanceof Error) return redact(`${err.name}: ${err.message}`);
  return redact(String(err));
}
