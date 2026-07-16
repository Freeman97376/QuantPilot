export type RuntimeMode = 'server' | 'desktop';

function normalizeRuntimeMode(value: string | undefined): RuntimeMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'server' || normalized === 'desktop' ? normalized : null;
}

export function getRuntimeMode(): RuntimeMode {
  return (
    normalizeRuntimeMode(process.env.QUANTPILOT_RUNTIME_MODE) ||
    normalizeRuntimeMode(process.env.QUANTPILOT_DEPLOYMENT) ||
    'server'
  );
}

export const runtimeMode = getRuntimeMode();
export const isDesktopRuntime = runtimeMode === 'desktop';
export const isServerRuntime = runtimeMode === 'server';

export const OFFICIAL_DESKTOP_SERVER_URL =
  'https://mantleofintelligence.com/smartstock';
