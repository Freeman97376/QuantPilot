import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { SmartStrategyWorkbench } from '@/components/quant/SmartStrategyWorkbench';
import { getStrategyDashboardData } from '@/lib/quant/strategies';
import { formatCompactDate as formatDate } from '@/components/quant/console-primitives';

export const metadata: Metadata = {
  title: '智能策略 · QuantPilot',
};

export default async function SmartStrategyPage() {
  const data = await getStrategyDashboardData();
  return (
    <div className="min-h-screen bg-surface text-slate-900">
      <PageHeader
        title="智能策略"
        badge={<Badge variant="outline" className="bg-white text-slate-500">DeepSeek 受控选股</Badge>}
        subtitle={`自然语言生成技术筛选 JSON，命中列表联动 K 线详情 · 数据生成于 ${formatDate(data.generatedAt)}`}
      />
      <SmartStrategyWorkbench data={data} />
    </div>
  );
}

export const dynamic = 'force-dynamic';

