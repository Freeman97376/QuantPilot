import { NextResponse } from 'next/server';
import { DesktopConnectionError } from './server-auth';

export function connectionErrorResponse(error: unknown): NextResponse {
  if (error instanceof DesktopConnectionError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error('[desktop-connection]', error);
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}
