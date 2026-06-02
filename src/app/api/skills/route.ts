import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Skills management has been removed from the travel-only product surface.',
    },
    { status: 410 },
  );
}

export async function POST() {
  return GET();
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
