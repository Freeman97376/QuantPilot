import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/layout/PageHeader';
import { SmartStrategyWorkbench } from '@/components/quant/SmartStrategyWorkbench';
import { getSmartStrategyPageData } from '@/lib/quant/strategies';
import { getSmartStrategyRuntimeStatus } from '@/lib/quant/smart-strategy';
import { formatCompactDate as formatDate } from '@/components/quant/console-primitives';

export const metadata: Metadata = {
  title: '智能策略 · QuantPilot',
};

export default async function SmartStrategyPage() {
  const data = await getSmartStrategyPageData();
  const runtimeStatus = getSmartStrategyRuntimeStatus();
  return (
    <div className="min-h-screen bg-surface text-slate-900">
      <PageHeader
        title="智能策略"
        badge={(
          <Badge variant="outline" className="bg-white text-slate-500">
            {runtimeStatus.configured ? 'DeepSeek 受控选股' : '本地规则可用'}
          </Badge>
        )}
        subtitle={`自然语言编译受控技术筛选，命中列表联动 K 线详情 · 数据生成于 ${formatDate(data.generatedAt)}`}
      />
      <SmartStrategyWorkbench data={data} runtimeStatus={runtimeStatus} />
    </div>
  );
}

export const dynamic = 'force-dynamic';
