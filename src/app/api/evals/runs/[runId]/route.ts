import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Legacy eval run details have been removed. Use the travel route QA page instead.',
    },
    { status: 410 },
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
