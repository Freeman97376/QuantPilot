import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { travelHealth } from '@/lib/travel/planner';

export const metadata: Metadata = {
  title: '运行观测 | 北京旅游 Agent',
};

type Props = {
  searchParams?: Promise<{ view?: string }>;
};

export default async function OpsPlatformPage({ searchParams }: Props) {
  await searchParams;
  const health = await travelHealth();
  const cacheItems = [
    ['数据来源', health.data_source === 'local_json' ? '本地 JSON' : health.data_source],
    ['POI 数据', health.data_loaded ? '已加载' : '未加载'],
    ['POI 索引', health.cache.poi_index_ready ? '就绪' : '未就绪'],
    ['UGC 索引', health.cache.review_index_ready ? '就绪' : '未就绪'],
    ['数据库', health.database.skipped ? '已跳过' : '可选启用'],
    ['加载耗时', health.data_load_elapsed_ms == null ? '-' : `${health.data_load_elapsed_ms} ms`],
  ];

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-900">
      <section className="mx-auto max-w-5xl space-y-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Badge variant="outline">Travel Runtime</Badge>
          <h1 className="mt-4 text-3xl font-bold">路线生成健康与数据覆盖观测</h1>
          <p className="mt-2 text-sm text-slate-600">
            服务状态：{health.status} · 数据根目录：{health.data_root}
          </p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(health.counts).map(([key, value]) => (
            <div key={key} className="rounded-xl border bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">{key}</p>
              <p className="mt-2 text-3xl font-bold">{value}</p>
            </div>
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {cacheItems.map(([label, value]) => (
            <div key={label} className="rounded-xl border bg-white p-4 shadow-sm">
              <p className="text-xs text-slate-500">{label}</p>
              <p className="mt-2 text-lg font-semibold">{value}</p>
            </div>
          ))}
        </div>

        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-sm leading-6 text-emerald-800">
          {health.database.note}
        </div>

        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-800">
          {health.limitations.map((item) => (
            <p key={item}>- {item}</p>
          ))}
        </div>
      </section>
    </main>
  );
}

export const dynamic = 'force-dynamic';
