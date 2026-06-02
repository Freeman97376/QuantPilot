import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Quant capabilities have been removed. Use /api/v1/travel/options instead.',
    },
    { status: 410 },
  );
}
