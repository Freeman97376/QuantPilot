import { NextResponse } from 'next/server';
import { travelHealth } from '@/lib/travel/planner';

export async function GET() {
  return NextResponse.json({
    success: true,
    data: {
      product: 'beijing-travel-agent',
      travel: await travelHealth(),
      coreCapabilities: [
        'local_poi_ugc_data',
        'intent_parse',
        'route_plan',
        'dynamic_replan',
        'constraint_validation',
        'artifact_rendering',
      ],
    },
  });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
