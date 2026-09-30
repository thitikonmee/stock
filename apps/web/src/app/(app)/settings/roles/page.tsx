'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import { Badge, Button, Card, ErrorBox, Field, Input, Loading, Modal, PageHeader } from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Permission, Role } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

const MODULES: Record<string, string> = {
  tenancy: 'บริษัทและสาขา',
  billing: 'แพ็กเกจ',
  iam: 'ผู้ใช้และสิทธิ์',
  catalog: 'สินค้า',
  pricing: 'ราคาและโปรโมชัน',
  inventory: 'สต็อก',
  orders: 'คำสั่งซื้อ',
  pos: 'POS หน้าร้าน',
  purchasing: 'จัดซื้อ',
  customers: 'ลูกค้า',
  payments: 'การชำระเงิน',
  reporting: 'รายงาน',
  channels: 'ช่องทางขายออนไลน์',
  audit: 'Audit log',
  integrations: 'การเชื่อมต่อ',
};

export default function RolesPage() {
  const { me } = useMe();
  const roles = useResource<Role[]>('/roles');
  const { data: catalog } = useResource<Permission[]>('/permissions');
  const manage = can(me, 'role.manage');
  const mine = useMemo(
    () => new Set(me?.grants.filter((g) => g.scopeType === 'TENANT').map((g) => g.permission)),
    [me],
  );

  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  const grouped = useMemo(() => {
    const groups = new Map<string, Permission[]>();
    for (const p of catalog ?? []) groups.set(p.module, [...(groups.get(p.module) ?? []), p]);
    return [...groups];
  }, [catalog]);

  function open(role: Role | 'new', base?: Role) {
    setEditing(role);
    setError(undefined);
    setCode(role === 'new' ? '' : role.code);
    setName(role === 'new' ? (base ? `${base.name} (สำเนา)` : '') : role.name);
    setSelected(new Set(role === 'new' ? (base?.permissions ?? []) : role.permissions));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const permissions = [...selected];
      if (editing === 'new') await api('/roles', { method: 'POST', body: { code, name, permissions } });
      else if (editing) {
        await api(`/roles/${editing.id}`, {
          method: 'PATCH',
          body: { name, permissions },
          headers: { 'if-match': `"v${editing.version}"` },
        });
      }
      setEditing(null);
      await roles.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'การตั้งค่า', href: '/settings/branches' }, { label: 'บทบาทและสิทธิ์' }]}
        title="บทบาทและสิทธิ์"
        description="บทบาทของระบบแก้ไขไม่ได้ แต่สร้างสำเนาเป็นบทบาทใหม่ได้ · ให้สิทธิ์ได้เฉพาะที่คุณมีอยู่"
        actions={manage ? <Button onClick={() => open('new')}>สร้างบทบาท</Button> : null}
      />
      <ErrorBox error={roles.error} />
      {roles.loading && !roles.data ? <Loading /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        {roles.data?.map((r) => (
          <Card
            key={r.id}
            title={r.name}
            actions={
              <div className="flex items-center gap-2">
                {r.isSystem ? <Badge>ระบบ</Badge> : <Badge tone="teal">กำหนดเอง</Badge>}
                {manage && r.code !== 'OWNER' ? (
                  <Button variant="ghost" onClick={() => (r.isSystem ? open('new', r) : open(r))}>
                    {r.isSystem ? 'สร้างสำเนา' : 'แก้ไข'}
                  </Button>
                ) : null}
              </div>
            }
          >
            <p className="text-sm text-slate-600">{r.description ?? `${r.permissions.length} สิทธิ์`}</p>
            <p className="mt-2 text-xs text-slate-500">{r.permissions.length} สิทธิ์</p>
          </Card>
        ))}
      </div>

      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'สร้างบทบาท' : 'แก้ไขบทบาท'}
        onClose={() => setEditing(null)}
      >
        <form onSubmit={save} className="space-y-4">
          {editing === 'new' ? (
            <Field label="รหัสบทบาท" hint="ภาษาอังกฤษตัวใหญ่และ _ เช่น STOCK_CLERK">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                pattern="[A-Z][A-Z0-9_]{1,39}"
                required
              />
            </Field>
          ) : null}
          <Field label="ชื่อ">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <div className="max-h-80 space-y-4 overflow-y-auto rounded border border-slate-200 p-3">
            {grouped.map(([module, perms]) => (
              <fieldset key={module}>
                <legend className="mb-1 text-sm font-semibold">{MODULES[module] ?? module}</legend>
                {perms.map((p) => (
                  <label
                    key={p.code}
                    className={`flex items-center gap-2 py-0.5 text-sm ${mine.has(p.code) ? '' : 'text-slate-400'}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(p.code)}
                      disabled={!mine.has(p.code)}
                      onChange={(e) =>
                        setSelected((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(p.code);
                          else next.delete(p.code);
                          return next;
                        })
                      }
                    />
                    <span>{p.description}</span>
                    {p.dangerous ? <Badge tone="amber">สำคัญ</Badge> : null}
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(null)}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              บันทึก
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
