'use client';

import { useEffect, useState } from 'react';
import type { DesktopPreferences, MinuteDataPolicy } from '@/lib/desktop/preferences';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? '';

export default function DesktopDataSettings() {
  const [preferences, setPreferences] = useState<DesktopPreferences | null>(null);
  const [connection, setConnection] = useState<Record<string, string | null> | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (process.env.NEXT_PUBLIC_RUNTIME_MODE !== 'desktop') return;
    fetch(`${API_BASE}/api/desktop/preferences`, { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => setPreferences(payload.preferences));
    fetch(`${API_BASE}/api/desktop/connection`, { cache: 'no-store' })
      .then((response) => response.json())
      .then(setConnection)
      .catch(() => setConnection({ status: 'offline' }));
  }, []);

  if (process.env.NEXT_PUBLIC_RUNTIME_MODE !== 'desktop' || !preferences) return null;

  const update = async (change: Partial<DesktopPreferences>) => {
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE}/api/desktop/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(change),
      });
      const payload = await response.json();
      if (response.ok) setPreferences(payload.preferences);
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    setSaving(true);
    setConnectionError(null);
    try {
      const response = await fetch(`${API_BASE}/api/desktop/connection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '连接失败');
      setConnection(payload);
      setPassword('');
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    setSaving(true);
    try {
      await fetch(`${API_BASE}/api/desktop/connection`, { method: 'DELETE' });
      setConnection({ status: 'disconnected' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-5">
      <h3 className="text-lg font-medium text-slate-900">本地数据与诊断</h3>
      <p className="mt-1 text-sm leading-6 text-slate-600">本地数据库、策略、股票列表和行情不会同步到官方服务器。</p>
      <label className="mt-4 block text-sm font-medium text-slate-800" htmlFor="minute-policy">分钟数据</label>
      <select
        id="minute-policy"
        value={preferences.minuteDataPolicy}
        disabled={saving}
        onChange={(event) => update({ minuteDataPolicy: event.target.value as MinuteDataPolicy })}
        className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
      >
        <option value="enabled">允许按需获取（实际下载仍需再次确认）</option>
        <option value="disabled">禁止获取</option>
      </select>
      <label className="mt-4 flex items-start gap-3 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={preferences.diagnosticsConsent}
          disabled={saving}
          onChange={(event) => update({ diagnosticsConsent: event.target.checked })}
          className="mt-1"
        />
        <span>登录官方服务器后允许上传脱敏诊断。诊断会关联账号，默认关闭，服务器保留30天。</span>
      </label>
      <div className="mt-5 border-t border-blue-200 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-slate-900">官方服务器连接（可选）</p>
            <p className="mt-1 text-xs text-slate-600">固定地址：https://mantleofintelligence.com/smartstock</p>
          </div>
          <span className="rounded-full bg-white px-2.5 py-1 text-xs ring-1 ring-slate-200">
            {connection?.status ?? 'checking'}
          </span>
        </div>
        {connection?.status === 'connected' ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-white p-3 ring-1 ring-slate-200">
            <div className="text-sm text-slate-700">
              <p>账号：<span className="font-medium">{connection.username}</span></p>
              <p className="mt-1 text-xs text-slate-500">Access 到期：{connection.accessExpiresAt ? new Date(connection.accessExpiresAt).toLocaleString() : '-'}</p>
            </div>
            <button type="button" disabled={saving} onClick={disconnect} className="rounded-lg border border-slate-300 px-3 py-2 text-sm">断开连接</button>
          </div>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input value={username} onChange={(event) => setUsername(event.target.value)} placeholder="管理员创建的用户名" autoComplete="username" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
            <input value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密码（不会保存）" type="password" autoComplete="current-password" className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm" />
            <button type="button" disabled={saving || username.length < 3 || password.length < 12} onClick={connect} className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">连接</button>
          </div>
        )}
        {connectionError ? <p className="mt-2 text-xs text-red-700">{connectionError}</p> : null}
        <p className="mt-3 text-xs leading-5 text-slate-500">未登录、服务器不可达或账号失效时，本地选股、回测、工作空间和本地行情仍可正常使用。连接不启用云同步、LLM代理或行情代理。</p>
      </div>
    </div>
  );
}
