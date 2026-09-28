'use client';

import { useState, type FormEvent } from 'react';
import { useMe } from '@/components/shell';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  Notice,
  PageHeader,
  Select,
  Table,
  Td,
  formatDate,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Branch, Invitation, Member, Role, RoleAssignment, Warehouse } from '@/lib/client/types';
import { can } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

type Scope = { scopeType: RoleAssignment['scopeType']; scopeId: string | null };

function ScopePicker({
  value,
  onChange,
  branches,
  warehouses,
}: {
  value: Scope;
  onChange: (s: Scope) => void;
  branches: Branch[];
  warehouses: Warehouse[];
}) {
  const encoded = value.scopeType === 'TENANT' ? 'TENANT' : `${value.scopeType}:${value.scopeId}`;
  return (
    <Select
      value={encoded}
      onChange={(e) => {
        const [type, id] = e.target.value.split(':');
        onChange(
          type === 'TENANT'
            ? { scopeType: 'TENANT', scopeId: null }
            : { scopeType: type as Scope['scopeType'], scopeId: id ?? null },
        );
      }}
    >
      <option value="TENANT">ทั้งบริษัท</option>
      {branches.map((b) => (
        <option key={b.id} value={`BRANCH:${b.id}`}>
          เฉพาะสาขา {b.name}
        </option>
      ))}
      {warehouses.map((w) => (
        <option key={w.id} value={`WAREHOUSE:${w.id}`}>
          เฉพาะคลัง {w.name}
        </option>
      ))}
    </Select>
  );
}

export default function UsersPage() {
  const { me } = useMe();
  const members = useResource<Member[]>('/users');
  const invitations = useResource<Invitation[]>('/users/invitations');
  const { data: roles } = useResource<Role[]>('/roles');
  const { data: branches } = useResource<Branch[]>('/branches');
  const { data: warehouses } = useResource<Warehouse[]>('/warehouses');
  const manage = can(me, 'user.manage');
  const assignable = (roles ?? []).filter((r) => r.code !== 'OWNER');
  const roleName = (a: RoleAssignment) => roles?.find((r) => r.id === a.roleId)?.name ?? a.roleCode ?? '';
  const scopeName = (a: RoleAssignment) =>
    a.scopeType === 'TENANT'
      ? ''
      : ` · ${(a.scopeType === 'BRANCH' ? branches : warehouses)?.find((x) => x.id === a.scopeId)?.name ?? ''}`;

  // Invite
  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [scope, setScope] = useState<Scope>({ scopeType: 'TENANT', scopeId: null });
  const [inviteResult, setInviteResult] = useState<{ acceptUrl: string; emailSent: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  // Edit roles
  const [editing, setEditing] = useState<Member | null>(null);
  const [editRoleId, setEditRoleId] = useState('');
  const [editScope, setEditScope] = useState<Scope>({ scopeType: 'TENANT', scopeId: null });

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function invite(e: FormEvent) {
    e.preventDefault();
    await run(async () => {
      const res = await api<{ acceptUrl: string; emailSent: boolean }>('/users/invitations', {
        method: 'POST',
        body: { email, roles: [{ roleId, ...scope }] },
      });
      setInviteResult(res);
      setEmail('');
      await invitations.reload();
    });
  }

  return (
    <>
      <PageHeader
        title="ผู้ใช้งาน"
        description="สมาชิกในบริษัท บทบาท และคำเชิญ"
        actions={
          manage ? (
            <Button
              onClick={() => {
                setInviteOpen(true);
                setInviteResult(null);
                setRoleId(assignable.find((r) => r.code === 'CASHIER')?.id ?? assignable[0]?.id ?? '');
              }}
            >
              เชิญผู้ใช้
            </Button>
          ) : null
        }
      />
      <ErrorBox error={error ?? members.error} />
      <div className="mt-4 space-y-6">
        <Card title="สมาชิก">
          {members.loading && !members.data ? (
            <Loading />
          ) : (
            <Table head={['ชื่อ', 'อีเมล', 'บทบาท', '2FA', 'สถานะ', '']} empty={members.data?.length === 0}>
              {members.data?.map((m) => (
                <tr key={m.membershipId}>
                  <Td>
                    {m.displayName} {m.isOwner ? <Badge tone="teal">เจ้าของ</Badge> : null}
                  </Td>
                  <Td className="text-slate-600">{m.email}</Td>
                  <Td>{m.roles.map((a) => `${roleName(a)}${scopeName(a)}`).join(', ')}</Td>
                  <Td>{m.mfaEnabled ? <Badge tone="green">เปิด</Badge> : <Badge>ปิด</Badge>}</Td>
                  <Td>
                    {m.status === 'ACTIVE' ? (
                      <Badge tone="green">ใช้งาน</Badge>
                    ) : (
                      <Badge tone="red">ระงับ</Badge>
                    )}
                  </Td>
                  <Td className="text-right">
                    {manage && !m.isOwner && m.membershipId !== me?.membershipId ? (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setEditing(m);
                            setEditRoleId(m.roles[0]?.roleId ?? assignable[0]?.id ?? '');
                            setEditScope({
                              scopeType: m.roles[0]?.scopeType ?? 'TENANT',
                              scopeId: m.roles[0]?.scopeId ?? null,
                            });
                          }}
                        >
                          แก้บทบาท
                        </Button>
                        <Button
                          variant={m.status === 'ACTIVE' ? 'danger' : 'secondary'}
                          onClick={() =>
                            void run(async () => {
                              await api(`/users/${m.membershipId}`, {
                                method: 'PATCH',
                                body: { status: m.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' },
                              });
                              await members.reload();
                            })
                          }
                        >
                          {m.status === 'ACTIVE' ? 'ระงับ' : 'เปิดใช้'}
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card title="คำเชิญที่รอตอบรับ">
          <Table head={['อีเมล', 'บทบาท', 'เชิญโดย', 'หมดอายุ', '']} empty={invitations.data?.length === 0}>
            {invitations.data?.map((i) => (
              <tr key={i.id}>
                <Td>{i.email}</Td>
                <Td>{i.roles.map((a) => `${roleName(a)}${scopeName(a)}`).join(', ')}</Td>
                <Td>{i.invitedBy ?? '—'}</Td>
                <Td>{formatDate(i.expiresAt)}</Td>
                <Td className="text-right">
                  {manage ? (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void run(async () => {
                          await api(`/users/invitations/${i.id}`, { method: 'DELETE' });
                          await invitations.reload();
                        })
                      }
                    >
                      ยกเลิก
                    </Button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Modal open={inviteOpen} title="เชิญผู้ใช้" onClose={() => setInviteOpen(false)}>
        {inviteResult ? (
          <div className="space-y-4">
            <Notice tone={inviteResult.emailSent ? 'success' : 'warning'}>
              {inviteResult.emailSent
                ? 'ส่งอีเมลคำเชิญแล้ว'
                : 'ส่งอีเมลไม่สำเร็จ — คัดลอกลิงก์ด้านล่างส่งให้ผู้รับเอง'}
            </Notice>
            <Field label="ลิงก์คำเชิญ (หมดอายุใน 72 ชั่วโมง)">
              <Input readOnly value={inviteResult.acceptUrl} onFocus={(e) => e.target.select()} />
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                onClick={() => void navigator.clipboard.writeText(inviteResult.acceptUrl)}
              >
                คัดลอกลิงก์
              </Button>
              <Button onClick={() => setInviteOpen(false)}>เสร็จสิ้น</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={invite} className="space-y-4">
            <Field label="อีเมล">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </Field>
            <Field label="บทบาท">
              <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} required>
                {assignable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="ขอบเขต">
              <ScopePicker
                value={scope}
                onChange={setScope}
                branches={branches ?? []}
                warehouses={warehouses ?? []}
              />
            </Field>
            <ErrorBox error={error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setInviteOpen(false)}>
                ยกเลิก
              </Button>
              <Button type="submit" busy={busy}>
                ส่งคำเชิญ
              </Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        open={editing !== null}
        title={`แก้บทบาท: ${editing?.displayName ?? ''}`}
        onClose={() => setEditing(null)}
      >
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editing) return;
            const ok = await run(async () => {
              await api(`/users/${editing.membershipId}/roles`, {
                method: 'PUT',
                body: { roles: [{ roleId: editRoleId, ...editScope }] },
              });
              await members.reload();
            });
            if (ok) setEditing(null);
          }}
        >
          <Field label="บทบาท">
            <Select value={editRoleId} onChange={(e) => setEditRoleId(e.target.value)}>
              {assignable.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="ขอบเขต">
            <ScopePicker
              value={editScope}
              onChange={setEditScope}
              branches={branches ?? []}
              warehouses={warehouses ?? []}
            />
          </Field>
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
