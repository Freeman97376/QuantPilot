'use client';

import { useEffect, useState } from 'react';
import type { MinuteDataPolicy } from '@/lib/desktop/preferences';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export default function FirstRunMinuteData() {
  const [policy, setPolicy] = useState<MinuteDataPolicy | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_RUNTIME_MODE !== 'desktop') return;
    fetch(`${API_BASE}/api/desktop/preferences`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => setPolicy(payload.preferences?.minuteDataPolicy ?? 'unset'))
      .catch(() => setPolicy('unset'));
  }, []);

  const choose = async (next: Exclude<MinuteDataPolicy, 'unset'>) => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/api/desktop/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minuteDataPolicy: next }),
      });
      if (!response.ok) throw new Error('保存失败');
      setPolicy(next);
    } finally {
      setSaving(false);
    }
  };

  if (policy !== 'unset') return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/70 p-4 backdrop-blur-sm">
      <section className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-600">首次使用设置</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-950">是否允许按需获取分钟级行情？</h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          选择“允许”不会立即下载任何分钟数据。只有当你主动使用分钟分析且本地覆盖不足时，
          QuantPilot 才会先展示标的、时间范围、数据源、付费权限、预计耗时、下载量、磁盘占用和峰值内存，
          你再次确认后才会下载。
        </p>
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
          选择“不允许”后，任何功能都不得静默下载分钟数据；你可以稍后在设置中重新开启。
        </div>
        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={saving}
            onClick={() => choose('disabled')}
            className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            暂不允许
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => choose('enabled')}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            允许按需获取
          </button>
        </div>
      </section>
    </div>
  );
}
