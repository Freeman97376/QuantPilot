import { NextResponse } from 'next/server';
import { travelHealth } from '@/lib/travel/planner';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: await travelHealth(),
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
