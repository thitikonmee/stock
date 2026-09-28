'use client';

import { useState, type FormEvent } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorBox,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Table,
  Td,
} from '@/components/ui';
import { api } from '@/lib/client/api';
import type { Brand, Category, Unit } from '@/lib/client/types';
import { useResource } from '@/lib/client/use-resource';

export default function CategoriesBrandsUnitsPage() {
  return (
    <>
      <PageHeader title="หมวดหมู่ / แบรนด์ / หน่วยนับ" description="ข้อมูลหลักของสินค้า" />
      <div className="grid gap-6 lg:grid-cols-2">
        <CategoriesCard />
        <BrandsCard />
        <UnitsCard />
      </div>
    </>
  );
}

function CategoriesCard() {
  const categories = useResource<Category[]>('/categories');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', parentId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/categories', {
        method: 'POST',
        body: { name: form.name, ...(form.parentId ? { parentId: form.parentId } : {}) },
      });
      setForm({ name: '', parentId: '' });
      setOpen(false);
      await categories.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="หมวดหมู่" actions={<Button onClick={() => setOpen(true)}>เพิ่มหมวดหมู่</Button>}>
      <ErrorBox error={categories.error} />
      <Table head={['ชื่อ', 'พาธ']} empty={categories.data?.length === 0}>
        {categories.data?.map((c) => (
          <tr key={c.id}>
            <Td>{c.name}</Td>
            <Td className="font-mono text-xs text-slate-500">{c.path}</Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} title="เพิ่มหมวดหมู่" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <Field label="ชื่อหมวดหมู่">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <Field label="หมวดหมู่แม่ (ถ้ามี)">
            <Select value={form.parentId} onChange={(e) => setForm({ ...form, parentId: e.target.value })}>
              <option value="">— ไม่มี (หมวดหมู่หลัก) —</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </Select>
          </Field>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              บันทึก
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

function BrandsCard() {
  const brands = useResource<Brand[]>('/brands');
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/brands', { method: 'POST', body: { name } });
      setName('');
      setOpen(false);
      await brands.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="แบรนด์" actions={<Button onClick={() => setOpen(true)}>เพิ่มแบรนด์</Button>}>
      <ErrorBox error={brands.error} />
      <Table head={['ชื่อ', 'สถานะ']} empty={brands.data?.length === 0}>
        {brands.data?.map((b) => (
          <tr key={b.id}>
            <Td>{b.name}</Td>
            <Td>
              <Badge tone={b.isActive ? 'green' : 'slate'}>{b.isActive ? 'ใช้งาน' : 'ปิด'}</Badge>
            </Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} title="เพิ่มแบรนด์" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <Field label="ชื่อแบรนด์">
            <Input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              บันทึก
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}

function UnitsCard() {
  const units = useResource<Unit[]>('/units');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', name: '', allowDecimal: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api('/units', { method: 'POST', body: form });
      setForm({ code: '', name: '', allowDecimal: false });
      setOpen(false);
      await units.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="หน่วยนับ" actions={<Button onClick={() => setOpen(true)}>เพิ่มหน่วย</Button>}>
      <ErrorBox error={units.error} />
      <Table head={['รหัส', 'ชื่อ', 'ทศนิยม']} empty={units.data?.length === 0}>
        {units.data?.map((u) => (
          <tr key={u.id}>
            <Td className="font-mono">{u.code}</Td>
            <Td>{u.name}</Td>
            <Td>{u.allowDecimal ? 'ได้' : 'ไม่ได้'}</Td>
          </tr>
        ))}
      </Table>
      <Modal open={open} title="เพิ่มหน่วยนับ" onClose={() => setOpen(false)}>
        <form onSubmit={create} className="space-y-4">
          <Field label="รหัสหน่วย" hint="เช่น PCS, BOX, KG">
            <Input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              required
            />
          </Field>
          <Field label="ชื่อหน่วย">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </Field>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={form.allowDecimal}
              onChange={(e) => setForm({ ...form, allowDecimal: e.target.checked })}
            />
            อนุญาตจำนวนเป็นทศนิยม (เช่น กิโลกรัม, เมตร)
          </label>
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              บันทึก
            </Button>
          </div>
        </form>
      </Modal>
    </Card>
  );
}
