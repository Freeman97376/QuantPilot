import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json(
    {
      success: false,
      error: 'Quant strategies have been removed. Use the travel route platform and /api/v1/travel/* APIs.',
    },
    { status: 410 },
  );
}

export async function POST() {
  return GET();
}

export async function PATCH() {
  return GET();
}

export async function DELETE() {
  return GET();
}
