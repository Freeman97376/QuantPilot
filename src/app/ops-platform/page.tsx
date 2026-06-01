import type { Metadata } from 'next';
import { Badge } from '@/components/ui/badge';
import { travelHealth } from '@/lib/travel/planner';

export const metadata: Metadata = {
  title: '生成观测 · 北京旅游 Agent',
};

type Props = {
  searchParams?: Promise<{ view?: string }>;
};

export default async function OpsPlatformPage({ searchParams }: Props) {
  await searchParams;
  const health = await travelHealth();
  return (
    <main className="min-h-screen bg-slate-50 px-6 py-8 text-slate-900">
      <section className="mx-auto max-w-5xl space-y-6">
        <div className="rounded-2xl border bg-white p-6 shadow-sm">
          <Badge variant="outline">Travel Runtime</Badge>
          <h1 className="mt-4 text-3xl font-bold">路线生成健康与数据覆盖</h1>
          <p className="mt-2 text-sm text-slate-600">服务状态：{health.status} · 数据根目录：{health.data_root}</p>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(health.counts).map(([key, value]) => (
            <div key={key} className="rounded-xl border bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">{key}</p>
              <p className="mt-2 text-3xl font-bold">{value}</p>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-800">
          {health.limitations.map((item) => <p key={item}>· {item}</p>)}
        </div>
      </section>
    </main>
  );
}

export const dynamic = 'force-dynamic';
