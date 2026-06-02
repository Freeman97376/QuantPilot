import { NextResponse } from 'next/server';
import { travelHealth } from '@/lib/travel/planner';

export async function GET() {
  const health = await travelHealth();
  return NextResponse.json({
    success: true,
    data: {
      product: 'beijing-travel-agent',
      checks: [
        '至少 3 个 POI',
        '混合路线包含餐饮 + 文化/娱乐',
        '预算与总时长约束',
        'UGC 排队/性价比证据',
        '动态重规划成功率',
        '生成耗时小于 10 秒',
      ],
      health,
    },
  });
}

export async function POST() {
  return NextResponse.json(
    {
      success: false,
      error: 'Benchmark queue has been removed. Use scripts/checks/check-travel-*.js for local route QA.',
    },
    { status: 410 },
  );
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
