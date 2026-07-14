function normalizePathPrefix(value: string | undefined): string {
  const raw = value?.trim() ?? '';
  if (!raw || raw === '/') {
    return '';
  }
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

export function getPreviewProxyBase(): string {
  return normalizePathPrefix(process.env.QUANTPILOT_PREVIEW_PROXY_BASE);
}

export function getPreviewBasePath(port: number): string {
  const proxyBase = getPreviewProxyBase();
  return proxyBase ? `${proxyBase}/${port}` : '';
}

export function getInternalPreviewUrl(port: number): string {
  return `http://localhost:${port}${getPreviewBasePath(port)}`;
}

function getPreviewPublicOrigin(): string {
  const explicit = process.env.QUANTPILOT_PREVIEW_PUBLIC_ORIGIN?.trim();
  if (explicit) {
    return explicit.replace(/\/+$/, '');
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!appUrl) {
    return '';
  }
  try {
    return new URL(appUrl).origin;
  } catch {
    return '';
  }
}

export function getPublicPreviewUrl(port: number | null | undefined, fallback: string | null): string | null {
  if (!port || !getPreviewProxyBase()) {
    return fallback;
  }
  const origin = getPreviewPublicOrigin();
  return origin ? `${origin}${getPreviewBasePath(port)}` : fallback;
}
