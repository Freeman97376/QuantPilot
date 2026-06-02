import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Skill packages have been removed from the travel-only product surface.',
    },
    { status: 410 },
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
