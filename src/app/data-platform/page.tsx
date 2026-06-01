import { getTravelCapabilityCenterData } from '@/lib/travel/capability-center';
import CapabilityCenterClient from './CapabilityCenterClient';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'POI 数据平台 · 北京旅游 Agent',
};

export default async function DataPlatformPage() {
  const data = await getTravelCapabilityCenterData();
  return <CapabilityCenterClient initialData={data} />;
}

export const dynamic = 'force-dynamic';
