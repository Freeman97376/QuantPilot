import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  connectOfficialServer,
  disconnectOfficialServer,
  getOfficialConnectionStatus,
} from '@/lib/desktop/official-connection';
import { isDesktopRuntime } from '@/lib/runtime/mode';

const loginSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(128),
}).strict();

export async function GET() {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(await getOfficialConnectionStatus());
}

export async function POST(request: NextRequest) {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const input = loginSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: '账号或密码错误' }, { status: 400 });
  try {
    return NextResponse.json(await connectOfficialServer(input.data.username, input.data.password));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '连接失败' },
      { status: 401 }
    );
  }
}

export async function DELETE() {
  if (!isDesktopRuntime) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  await disconnectOfficialServer();
  return NextResponse.json({ status: 'disconnected' });
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
