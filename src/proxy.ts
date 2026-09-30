import { NextRequest, NextResponse } from 'next/server';

const DESKTOP_COOKIE_NAME = 'quantpilot_launch';
const DESKTOP_HEADER_NAME = 'x-quantpilot-launch-token';

function isDesktopRuntime(): boolean {
  const runtimeMode = (
    process.env.QUANTPILOT_RUNTIME_MODE ||
    process.env.QUANTPILOT_DEPLOYMENT ||
    'server'
  ).trim().toLowerCase();
  return runtimeMode === 'desktop';
}

function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (!actual || actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

export function proxy(request: NextRequest) {
  if (!isDesktopRuntime()) return NextResponse.next();

  const expectedToken = process.env.QUANTPILOT_LAUNCH_TOKEN?.trim();
  if (!expectedToken) {
    return NextResponse.json(
      { success: false, error: 'Desktop API authorization is unavailable' },
      { status: 503 },
    );
  }

  const cookieToken = request.cookies.get(DESKTOP_COOKIE_NAME)?.value;
  const smokeHeaderToken =
    process.env.QUANTPILOT_DESKTOP_SMOKE_TEST === '1'
      ? request.headers.get(DESKTOP_HEADER_NAME) ?? undefined
      : undefined;
  if (tokensEqual(cookieToken, expectedToken) || tokensEqual(smokeHeaderToken, expectedToken)) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { success: false, error: 'Unauthorized' },
    { status: 401 },
  );
}

export const config = {
  matcher: ['/api/:path*'],
};
