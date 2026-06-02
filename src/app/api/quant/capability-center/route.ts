import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Quant capability center has been removed. Use /api/travel/capability-center instead.',
    },
    { status: 410 },
  );
}
