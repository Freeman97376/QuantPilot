const DEFAULT_MARKET_API_URL = 'http://127.0.0.1:8000';

export const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL
  || process.env.QUANTPILOT_MARKET_API_BASE_URL
  || DEFAULT_MARKET_API_URL;

export function marketApiHeaders(input?: HeadersInit) {
  const headers = new Headers(input);
  const startupToken = process.env.QUANTPILOT_LAUNCH_TOKEN?.trim();
  if (startupToken) {
    headers.set('X-QuantPilot-Startup-Token', startupToken);
  }
  return headers;
}

export function marketApiFetch(pathName: string, init: RequestInit = {}) {
  const path = pathName.startsWith('/') ? pathName : `/${pathName}`;
  return fetch(`${MARKET_API_BASE_URL}${path}`, {
    ...init,
    headers: marketApiHeaders(init.headers),
  });
}
