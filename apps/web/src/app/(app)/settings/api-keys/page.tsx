'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Modal,
  Notice,
  PageHeader,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { ApiKey, Permission } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

export default function ApiKeysPage() {
  const { me } = useMe();
  const keys = useResource<ApiKey[]>('/api-keys');
  const { data: catalog } = useResource<Permission[]>('/permissions');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [ipAllowlist, setIpAllowlist] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  // Keys never hold dangerous permissions, and only what the creator holds company-wide.
  const grantable = useMemo(() => {
    const mine = new Set(me?.grants.filter((g) => g.scopeType === 'TENANT').map((g) => g.permission));
    return (catalog ?? []).filter((p) => !p.dangerous && mine.has(p.code));
  }, [catalog, me]);

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const ips = ipAllowlist.split(/[\s,]+/).filter(Boolean);
      const res = await api<{ secret: string }>('/api-keys', {
        method: 'POST',
        body: { name, permissions: [...selected], ...(ips.length ? { ipAllowlist: ips } : {}) },
      });
      setSecret(res.secret);
      await keys.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'การตั้งค่า', href: '/settings/branches' }, { label: 'API keys' }]}
        title="API keys"
        description="ให้ระบบภายนอก (ERP, เว็บไซต์) เข้าถึงข้อมูลตามสิทธิ์ที่กำหนด — key ทำงานในนามผู้สร้าง"
        actions={
          <Button
            onClick={() => {
              setName('');
              setIpAllowlist('');
              setSelected(new Set());
              setSecret(null);
              setError(undefined);
              setOpen(true);
            }}
          >
            สร้าง API key
          </Button>
        }
      />
      <ErrorBox error={keys.error} />
      <Card>
        <Table head={['ชื่อ', 'Key', 'สิทธิ์', 'ใช้ล่าสุด', 'สถานะ', '']} empty={keys.data?.length === 0}>
          {keys.data?.map((k) => (
            <tr key={k.id}>
              <Td>{k.name}</Td>
              <Td className="font-mono text-xs">{k.prefix}…</Td>
              <Td className="text-xs text-slate-600">{k.permissions.join(', ')}</Td>
              <Td>{formatDate(k.lastUsedAt)}</Td>
              <Td>
                {k.revokedAt ? <Badge tone="red">ยกเลิกแล้ว</Badge> : <Badge tone="green">ใช้งาน</Badge>}
              </Td>
              <Td className="text-right">
                {!k.revokedAt ? (
                  <Button
                    variant="danger"
                    onClick={async () => {
                      try {
                        await api(`/api-keys/${k.id}`, { method: 'DELETE' });
                        await keys.reload();
                      } catch (err) {
                        setError(err);
                      }
                    }}
                  >
                    ยกเลิก
                  </Button>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Modal open={open} title={secret ? 'API key ใหม่' : 'สร้าง API key'} onClose={() => setOpen(false)}>
        {secret ? (
          <div className="space-y-4">
            <Notice tone="warning">คัดลอกเก็บไว้ตอนนี้ — ระบบจะไม่แสดง key นี้อีก</Notice>
            <Input readOnly value={secret} onFocus={(e) => e.target.select()} className="font-mono text-xs" />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(secret)}>
                คัดลอก
              </Button>
              <Button onClick={() => setOpen(false)}>เสร็จสิ้น</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={create} className="space-y-4">
            <Field label="ชื่อ">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="เช่น ERP sync"
                required
              />
            </Field>
            <fieldset className="max-h-56 space-y-1 overflow-y-auto rounded border border-slate-200 p-3">
              <legend className="px-1 text-sm font-medium">สิทธิ์</legend>
              {grantable.map((p) => (
                <label key={p.code} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.has(p.code)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (e.target.checked) next.add(p.code);
                        else next.delete(p.code);
                        return next;
                      })
                    }
                  />
                  {p.description} <span className="font-mono text-xs text-slate-400">{p.code}</span>
                </label>
              ))}
            </fieldset>
            <Field
              label="จำกัด IP (ไม่บังคับ)"
              hint="คั่นด้วยเว้นวรรคหรือจุลภาค เช่น 203.0.113.10 10.0.0.0/8"
            >
              <Input value={ipAllowlist} onChange={(e) => setIpAllowlist(e.target.value)} />
            </Field>
            <ErrorBox error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" busy={busy} disabled={selected.size === 0}>
                สร้าง
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
