import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { travelHealth } from '@/lib/travel/planner';

export const metadata: Metadata = {
  title: '路线质量评测 · 北京旅游 Agent',
};

export default async function EvalPlatformPage() {
  const health = await travelHealth();
  const checks = [
    ['路线 POI 串联', '至少 3 个 POI，文化/餐饮覆盖可验证'],
    ['混合类别覆盖', '混合路线至少 1 个餐饮 + 2 个文化/娱乐 POI'],
    ['预算与时长', '输出 within_budget / within_duration 与风险提示'],
    ['UGC 证据', '展示排队风险、性价比、亲子友好和环境质量信号'],
    ['响应时间', '本地生成目标小于 10 秒'],
  ];
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-900">
      <section className="mx-auto max-w-5xl space-y-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Badge variant="outline">Route QA</Badge>
          <h1 className="mt-4 text-3xl font-bold">路线质量评测平台</h1>
          <p className="mt-2 text-sm text-slate-600">
            当前本地数据：{health.counts.planner_entities} 个规划实体，{health.counts.review_aggregates} 条 UGC 聚合特征。
          </p>
        </div>
        <div className="grid gap-3">
          {checks.map(([title, desc]) => (
            <div key={title} className="rounded-xl border bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">{title}</h2>
                <Badge className="bg-emerald-50 text-emerald-700" variant="outline">已纳入</Badge>
              </div>
              <p className="mt-2 text-sm text-slate-600">{desc}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export const dynamic = 'force-dynamic';
