import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getTravelCapabilityCenterData } from '@/lib/travel/capability-center';

export const metadata: Metadata = {
  title: '路线方案平台 | 北京旅游 Agent',
};

export default async function StrategyPlatformPage() {
  const data = await getTravelCapabilityCenterData();
  const routeCapabilities = data.capabilities.filter((item) => item.groupId === 'route_planning' || item.id.includes('route'));

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-900">
      <section className="mx-auto max-w-6xl space-y-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Badge variant="outline">北京旅游 Agent</Badge>
          <h1 className="mt-4 text-3xl font-bold">路线方案平台</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            管理文化路线、餐饮混排、预算优先、效率优先和动态重规划能力。所有方案基于本地北京
            POI、UGC 评价特征和静态营业时间生成，并明确标注估算边界。
          </p>
          <div className="mt-5 flex gap-3">
            <Button asChild>
              <Link href="/">创建路线任务</Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/data-platform">查看 POI 数据</Link>
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {routeCapabilities.map((capability) => (
            <article key={capability.id} className="rounded-xl border bg-white p-5 shadow-sm">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-semibold">{capability.name}</h2>
                <Badge variant="secondary">{capability.shortName}</Badge>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">{capability.description}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                {capability.tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
              <p className="mt-4 text-xs text-slate-500">{capability.inputHint}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export const dynamic = 'force-dynamic';
