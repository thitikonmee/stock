'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Loading,
  Notice,
  PageHeader,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api, ApiError } from '@/lib/client/api';
import { messageFor } from '@/lib/client/messages';
import type { ChannelAccount, ChannelAccountStatus } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const STATUS_LABEL: Record<ChannelAccountStatus, string> = {
  CONNECTING: 'กำลังเชื่อมต่อ',
  CONNECTED: 'เชื่อมต่ออยู่',
  TOKEN_EXPIRED: 'โทเคนหมดอายุ',
  ERROR: 'มีข้อผิดพลาด',
  PAUSED: 'พักไว้',
  DISCONNECTED: 'ยกเลิกการเชื่อมต่อแล้ว',
};
const STATUS_TONE: Record<ChannelAccountStatus, 'slate' | 'amber' | 'green' | 'red' | 'teal'> = {
  CONNECTING: 'amber',
  CONNECTED: 'green',
  TOKEN_EXPIRED: 'amber',
  ERROR: 'red',
  PAUSED: 'amber',
  DISCONNECTED: 'slate',
};

export default function ChannelsPage() {
  const { me } = useMe();
  const { data: accounts, error, loading } = useResource<ChannelAccount[]>('/channel-accounts');
  const [banner, setBanner] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [connecting, setConnecting] = useState<'shopee' | 'lazada' | 'tiktok' | null>(null);
  const [connectError, setConnectError] = useState<unknown>();

  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    if (q.get('connected')) setBanner({ tone: 'success', text: 'เชื่อมต่อร้านค้าสำเร็จ' });
    else if (q.get('error')) {
      const reason = messageFor(new ApiError(0, q.get('code') ?? 'ERROR', q.get('error') ?? ''));
      setBanner({ tone: 'warning', text: `เชื่อมต่อไม่สำเร็จ: ${reason}` });
    }
    if (q.get('connected') || q.get('error')) window.history.replaceState({}, '', '/channels');
  }, []);

  async function connect(channelCode: 'shopee' | 'lazada' | 'tiktok') {
    setConnecting(channelCode);
    setConnectError(undefined);
    try {
      const res = await api<{ authorizeUrl: string }>(`/channels/${channelCode}/connect`, { method: 'POST' });
      window.open(res.authorizeUrl, '_blank', 'noopener');
    } catch (err) {
      setConnectError(err);
    } finally {
      setConnecting(null);
    }
  }

  return (
    <>
      <PageHeader
        title="ช่องทางขาย"
        description="เชื่อมต่อร้านค้าบนมาร์เก็ตเพลส (Shopee ฯลฯ) — sync สต็อก รับออเดอร์อัตโนมัติ"
        actions={
          can(me, 'channel.manage') ? (
            <div className="flex gap-2">
              <Button onClick={() => connect('shopee')} busy={connecting === 'shopee'}>
                เชื่อม Shopee
              </Button>
              <Button variant="secondary" onClick={() => connect('lazada')} busy={connecting === 'lazada'}>
                เชื่อม Lazada
              </Button>
              <Button variant="secondary" onClick={() => connect('tiktok')} busy={connecting === 'tiktok'}>
                เชื่อม TikTok
              </Button>
            </div>
          ) : undefined
        }
      />
      {banner ? <Notice tone={banner.tone}>{banner.text}</Notice> : null}
      <ErrorBox error={error} />
      {connectError ? <ErrorBox error={connectError} /> : null}
      <Card>
        <Table
          head={['ร้านค้า', 'ช่องทาง', 'สถานะ', 'sync ล่าสุด', 'เชื่อมเมื่อ']}
          empty={!loading && (accounts?.length ?? 0) === 0}
        >
          {(accounts ?? []).map((a) => (
            <tr key={a.id}>
              <Td>
                <Link href={`/channels/${a.id}`} className="text-brand-700 underline">
                  {a.shopName ?? a.externalShopId}
                </Link>
              </Td>
              <Td>{a.channelCode}</Td>
              <Td>
                <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
              </Td>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(a.lastOrderSyncAt)}</Td>
              <Td className="whitespace-nowrap text-slate-600">{formatDate(a.createdAt)}</Td>
            </tr>
          ))}
        </Table>
        {loading ? <Loading /> : null}
      </Card>
    </>
  );
}
