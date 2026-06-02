import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Quant validation has been removed. Travel validation is covered by route QA checks.',
    },
    { status: 410 },
  );
}

export async function POST() {
  return GET();
}
