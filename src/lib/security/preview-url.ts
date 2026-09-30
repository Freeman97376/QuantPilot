export interface PreviewPortBounds {
  start: number;
  end: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function normalizeLoopbackPreviewUrl(
  value: string,
  bounds: PreviewPortBounds,
  expectedPort?: number,
): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }

  if (
    url.protocol !== 'http:'
    || url.username
    || url.password
    || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())
    || !url.port
  ) {
    return null;
  }

  const port = Number(url.port);
  if (
    !Number.isSafeInteger(port)
    || port < bounds.start
    || port > bounds.end
    || (expectedPort !== undefined && port !== expectedPort)
  ) {
    return null;
  }

  url.hash = '';
  return url.toString();
}
