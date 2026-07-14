const SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;

export const APP_BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? '';
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE?.trim() || APP_BASE_PATH;

function isPassthroughUrl(value: string): boolean {
  return (
    SCHEME_PATTERN.test(value) ||
    value.startsWith('//') ||
    value.startsWith('#') ||
    value.startsWith('?')
  );
}

function joinBase(base: string, value: string): string {
  const input = value.trim();
  if (!input || isPassthroughUrl(input)) {
    return input;
  }

  const normalizedBase = base.trim().replace(/\/+$/, '');
  if (!normalizedBase) {
    return input.startsWith('/') ? input : `/${input}`;
  }

  if (input === normalizedBase || input.startsWith(`${normalizedBase}/`)) {
    return input;
  }

  return `${normalizedBase}${input.startsWith('/') ? input : `/${input}`}`;
}

/** Prefix a raw browser/static URL with the configured Next.js basePath. */
export function withBasePath(value: string): string {
  return joinBase(APP_BASE_PATH, value);
}

/** Prefix a platform API URL, while preserving explicit absolute API URLs. */
export function withApiBase(value: string): string {
  return joinBase(API_BASE, value);
}

/** Remove the deployment prefix before comparing a browser pathname to app routes. */
export function withoutBasePath(value: string): string {
  if (!APP_BASE_PATH) {
    return value;
  }
  if (value === APP_BASE_PATH) {
    return '/';
  }
  return value.startsWith(`${APP_BASE_PATH}/`) ? value.slice(APP_BASE_PATH.length) : value;
}
