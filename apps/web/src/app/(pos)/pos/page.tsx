'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
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
  Select,
  Td,
} from '@/components/ui';
import { ApiError } from '@/lib/client/api';
import {
  forgetDevice,
  loadDevice,
  posApi,
  posLogin,
  posLogout,
  saveDevice,
  type StoredDevice,
} from '@/lib/client/pos-api';
import type {
  Customer,
  ManagerOverride,
  Me,
  PosPaymentMethod,
  Sale,
  Shift,
  Variant,
} from '@/lib/client/types';

type View = 'loading' | 'register' | 'pin' | 'open-shift' | 'till';

/**
 * The POS terminal — online-only browser fallback (docs/05-pos.md's hardware table): no offline
 * mode, no native printer/scanner bridge, receipts print via the browser. One screen, a small state
 * machine: register this browser as a device once, then cashiers come and go with their PIN.
 */
export default function PosPage() {
  const [view, setView] = useState<View>('loading');
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [shift, setShift] = useState<Shift | null>(null);
  const [bootError, setBootError] = useState<unknown>();

  useEffect(() => {
    void bootstrap();
    // run once on mount
  }, []);

  async function bootstrap() {
    const dev = loadDevice();
    setDevice(dev);
    if (!dev) {
      setView('register');
      return;
    }
    try {
      const meRes = await posApi<Me>('/me');
      setMe(meRes);
      await refreshShift(dev, meRes);
    } catch {
      setView('pin');
    }
  }

  async function refreshShift(dev: StoredDevice, meRes: Me) {
    if (!meRes.grants.some((g) => g.permission === 'pos.sell')) {
      setBootError(new ApiError(403, 'FORBIDDEN', 'บัญชีนี้ไม่มีสิทธิ์ขายที่ POS'));
      setView('pin');
      return;
    }
    const s = await posApi<Shift | null>(`/pos/shifts/current?posDeviceId=${dev.deviceId}`);
    setShift(s);
    setView(s ? 'till' : 'open-shift');
  }

  async function onSwitchUser() {
    await posLogout();
    setMe(null);
    setShift(null);
    setBootError(undefined);
    setView('pin');
  }

  if (view === 'loading') {
    return (
      <Centered>
        <Loading />
      </Centered>
    );
  }
  if (view === 'register') {
    return (
      <Centered>
        <RegisterCard
          onRegistered={(dev) => {
            saveDevice(dev);
            setDevice(dev);
            setView('pin');
          }}
        />
      </Centered>
    );
  }
  if (view === 'pin' && device) {
    return (
      <Centered>
        <div className="space-y-4">
          <ErrorBox error={bootError} />
          <PinPad
            device={device}
            onLoggedIn={async () => {
              const meRes = await posApi<Me>('/me');
              setMe(meRes);
              await refreshShift(device, meRes);
            }}
          />
          <button
            className="w-full text-center text-xs text-slate-400 underline"
            onClick={() => {
              forgetDevice();
              setDevice(null);
              setView('register');
            }}
          >
            ลบทะเบียนเครื่องนี้ (ตั้งค่าเครื่องใหม่)
          </button>
        </div>
      </Centered>
    );
  }
  if (view === 'open-shift' && device && me) {
    return (
      <Centered>
        <OpenShiftCard
          device={device}
          me={me}
          onOpened={(s) => {
            setShift(s);
            setView('till');
          }}
          onSwitchUser={onSwitchUser}
        />
      </Centered>
    );
  }
  if (view === 'till' && device && me && shift) {
    return (
      <TillView
        device={device}
        me={me}
        shift={shift}
        onSwitchUser={onSwitchUser}
        onShiftClosed={async () => {
          setShift(null);
          await onSwitchUser();
        }}
      />
    );
  }
  return null;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center text-2xl font-bold text-brand-700">StockOS POS</div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------- register

function RegisterCard({ onRegistered }: { onRegistered: (device: StoredDevice) => void }) {
  const [form, setForm] = useState({ tenantSlug: '', registrationCode: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await posApi<{
        deviceId: string;
        branchId: string;
        warehouseId: string;
        deviceToken: string;
      }>('/pos/devices/register', { method: 'POST', body: { ...form, platform: 'WEB' } });
      onRegistered({
        deviceId: res.deviceId,
        deviceToken: res.deviceToken,
        branchId: res.branchId,
        warehouseId: res.warehouseId,
        tenantSlug: form.tenantSlug,
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="ลงทะเบียนเครื่องนี้">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          ขอรหัสลงทะเบียนจากผู้ดูแลระบบ (เมนู เครื่อง POS ในหลังบ้าน)
          แล้วกรอกที่นี่ครั้งเดียวต่อเครื่อง/เบราว์เซอร์
        </p>
        <Field label="รหัสร้าน (URL)">
          <Input
            value={form.tenantSlug}
            onChange={(e) => setForm({ ...form, tenantSlug: e.target.value.trim() })}
            autoCapitalize="off"
            required
          />
        </Field>
        <Field label="รหัสลงทะเบียน">
          <Input
            value={form.registrationCode}
            onChange={(e) => setForm({ ...form, registrationCode: e.target.value.toUpperCase() })}
            placeholder="XXXXX-XXXXX"
            required
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="w-full">
          ลงทะเบียน
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------- PIN login

function PinPad({ device, onLoggedIn }: { device: StoredDevice; onLoggedIn: () => Promise<void> }) {
  const [employeeCode, setEmployeeCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await posLogin(device.deviceToken, employeeCode, pin);
      setPin('');
      await onLoggedIn();
    } catch (err) {
      setError(err);
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="เข้าสู่ระบบพนักงานขาย">
      <form onSubmit={submit} className="space-y-4">
        <Field label="รหัสพนักงาน">
          <Input
            value={employeeCode}
            onChange={(e) => setEmployeeCode(e.target.value.toUpperCase())}
            autoFocus
            required
          />
        </Field>
        <Field label="PIN (4-6 หลัก)">
          <Input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            type="password"
            required
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="w-full" disabled={pin.length < 4}>
          เข้าสู่ระบบ
        </Button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------- open shift

function OpenShiftCard({
  device,
  me,
  onOpened,
  onSwitchUser,
}: {
  device: StoredDevice;
  me: Me;
  onOpened: (shift: Shift) => void;
  onSwitchUser: () => Promise<void>;
}) {
  const [openingCash, setOpeningCash] = useState('0.00');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const s = await posApi<Shift>('/pos/shifts', {
        method: 'POST',
        body: { posDeviceId: device.deviceId, openingCash },
      });
      onOpened(s);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="เปิดกะการขาย">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-slate-600">
          {me.displayName} · เครื่อง {device.deviceId.slice(-8)}
        </p>
        <Field label="เงินสดเริ่มกะ (บาท)">
          <Input
            value={openingCash}
            onChange={(e) => setOpeningCash(e.target.value)}
            inputMode="decimal"
            required
          />
        </Field>
        <ErrorBox error={error} />
        <Button type="submit" busy={busy} className="w-full">
          เปิดกะ
        </Button>
        <button
          type="button"
          className="w-full text-center text-xs text-slate-400 underline"
          onClick={onSwitchUser}
        >
          สลับผู้ใช้
        </button>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------- till (cart + sell)

interface CartLine {
  variantId: string;
  sku: string;
  name: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
}

function estimateTotal(cart: CartLine[]): string {
  const raw = cart.reduce(
    (sum, l) => sum + Number(l.unitPrice) * Number(l.quantity) - Number(l.discountAmount || '0'),
    0,
  );
  return Math.max(0, Math.round(raw)).toFixed(2);
}

function TillView({
  device,
  me,
  shift,
  onSwitchUser,
  onShiftClosed,
}: {
  device: StoredDevice;
  me: Me;
  shift: Shift;
  onSwitchUser: () => Promise<void>;
  onShiftClosed: () => Promise<void>;
}) {
  const [cart, setCart] = useState<CartLine[]>([]);
  const [query, setQuery] = useState('');
  const [searchError, setSearchError] = useState<unknown>();
  const [searchBusy, setSearchBusy] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [closeOpen, setCloseOpen] = useState(false);
  const [receipt, setReceipt] = useState<Sale | null>(null);
  const [refundSale, setRefundSale] = useState<Sale | null>(null);
  const [recent, setRecent] = useState<Sale[]>([]);

  async function loadRecent() {
    try {
      const list = await posApi<Sale[]>(`/pos/sales?posDeviceId=${device.deviceId}`);
      setRecent(list);
    } catch {
      // Recent-sales list is a convenience panel, not worth surfacing a hard error over.
    }
  }
  useEffect(() => {
    void loadRecent();
    // run once on mount
  }, []);

  async function addByCode(code: string) {
    const trimmed = code.trim();
    if (!trimmed) return;
    setSearchBusy(true);
    setSearchError(undefined);
    try {
      const param = /^\d+$/.test(trimmed)
        ? `barcode=${encodeURIComponent(trimmed)}`
        : `sku=${encodeURIComponent(trimmed)}`;
      const variant = await posApi<Variant>(`/variants/lookup?${param}`);
      setCart((prev) => {
        const existing = prev.find((l) => l.variantId === variant.id);
        if (existing) {
          return prev.map((l) =>
            l.variantId === variant.id ? { ...l, quantity: String(Number(l.quantity) + 1) } : l,
          );
        }
        return [
          ...prev,
          {
            variantId: variant.id,
            sku: variant.sku,
            name: variant.name,
            quantity: '1',
            unitPrice: variant.sellingPrice,
            discountAmount: '0',
          },
        ];
      });
      setQuery('');
    } catch (err) {
      setSearchError(err);
    } finally {
      setSearchBusy(false);
    }
  }

  function updateLine(variantId: string, patch: Partial<CartLine>) {
    setCart((prev) => prev.map((l) => (l.variantId === variantId ? { ...l, ...patch } : l)));
  }
  function removeLine(variantId: string) {
    setCart((prev) => prev.filter((l) => l.variantId !== variantId));
  }

  return (
    <div className="mx-auto flex h-screen max-w-6xl flex-col gap-4 p-4">
      <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2">
        <div className="text-sm">
          <span className="font-semibold">{me.displayName}</span>
          <span className="text-slate-400"> · เครื่อง {device.deviceId.slice(-8)}</span>
          <Badge tone="green">กะเปิดอยู่</Badge>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setCloseOpen(true)}>
            ปิดกะ
          </Button>
          <Button variant="ghost" onClick={onSwitchUser}>
            สลับผู้ใช้
          </Button>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-3 gap-4 overflow-hidden">
        <div className="col-span-2 flex flex-col gap-4 overflow-hidden">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void addByCode(query);
            }}
          >
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="สแกนบาร์โค้ด หรือพิมพ์ SKU แล้ว Enter"
              autoFocus
            />
          </form>
          <ErrorBox error={searchError} />
          {searchBusy ? <Loading /> : null}
          <Card className="flex-1 overflow-y-auto">
            {cart.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">ยังไม่มีสินค้าในตะกร้า</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-200 text-xs uppercase text-slate-500">
                  <tr>
                    <Td>SKU / ชื่อ</Td>
                    <Td>จำนวน</Td>
                    <Td>ราคา/หน่วย</Td>
                    <Td>ส่วนลด</Td>
                    <Td>รวม</Td>
                    <Td>{''}</Td>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {cart.map((l) => (
                    <tr key={l.variantId}>
                      <Td>
                        <div className="font-medium">{l.name}</div>
                        <div className="font-mono text-xs text-slate-500">{l.sku}</div>
                      </Td>
                      <Td>
                        <Input
                          className="w-20"
                          value={l.quantity}
                          onChange={(e) => updateLine(l.variantId, { quantity: e.target.value })}
                        />
                      </Td>
                      <Td>{Number(l.unitPrice).toFixed(2)}</Td>
                      <Td>
                        <Input
                          className="w-20"
                          value={l.discountAmount}
                          onChange={(e) => updateLine(l.variantId, { discountAmount: e.target.value })}
                        />
                      </Td>
                      <Td>
                        {(Number(l.unitPrice) * Number(l.quantity) - Number(l.discountAmount || '0')).toFixed(
                          2,
                        )}
                      </Td>
                      <Td>
                        <button
                          className="text-xs text-red-600 underline"
                          onClick={() => removeLine(l.variantId)}
                        >
                          ลบ
                        </button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4 overflow-hidden">
          <Card title="สรุปยอด (ประมาณการ)">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-slate-500">ยอดชำระโดยประมาณ</span>
              <span className="text-2xl font-bold">{estimateTotal(cart)}</span>
            </div>
            <p className="mt-1 text-xs text-slate-400">ยอดจริง (รวม VAT/ปัดเศษ) คำนวณตอนกดชำระเงิน</p>
            <Button
              className="mt-4 w-full"
              disabled={cart.length === 0}
              onClick={() => setCheckoutOpen(true)}
            >
              ชำระเงิน
            </Button>
          </Card>
          <Card title="ใบเสร็จล่าสุด" className="flex-1 overflow-y-auto">
            {recent.length === 0 ? (
              <p className="text-sm text-slate-500">ยังไม่มีการขายในเครื่องนี้</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {recent.map((s) => (
                  <li
                    key={s.orderId}
                    className="flex items-center justify-between border-b border-slate-100 pb-2"
                  >
                    <div>
                      <div className="font-mono text-xs">{s.orderNo}</div>
                      <div className="text-slate-500">{s.grandTotal} บาท</div>
                    </div>
                    <button className="text-xs text-brand-700 underline" onClick={() => setRefundSale(s)}>
                      คืนเงิน
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      {checkoutOpen ? (
        <CheckoutModal
          device={device}
          shift={shift}
          cart={cart}
          onClose={() => setCheckoutOpen(false)}
          onCompleted={(sale) => {
            setReceipt(sale);
            setCart([]);
            setCheckoutOpen(false);
            void loadRecent();
          }}
        />
      ) : null}
      {closeOpen ? (
        <CloseShiftModal shift={shift} onClose={() => setCloseOpen(false)} onClosed={onShiftClosed} />
      ) : null}
      {receipt ? <ReceiptModal sale={receipt} onClose={() => setReceipt(null)} /> : null}
      {refundSale ? (
        <RefundModal
          sale={refundSale}
          shiftId={shift.id}
          onClose={() => setRefundSale(null)}
          onRefunded={() => {
            setRefundSale(null);
            void loadRecent();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- checkout

function ManagerOverrideFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ManagerOverride;
  onChange: (v: ManagerOverride) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
      <p className="text-sm font-medium text-amber-900">{label}</p>
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="รหัสผู้จัดการ"
          value={value.employeeCode}
          onChange={(e) => onChange({ ...value, employeeCode: e.target.value.toUpperCase() })}
        />
        <Input
          placeholder="PIN ผู้จัดการ"
          type="password"
          inputMode="numeric"
          value={value.pin}
          onChange={(e) => onChange({ ...value, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
        />
      </div>
    </div>
  );
}

function CheckoutModal({
  device,
  shift,
  cart,
  onClose,
  onCompleted,
}: {
  device: StoredDevice;
  shift: Shift;
  cart: CartLine[];
  onClose: () => void;
  onCompleted: (sale: Sale) => void;
}) {
  const estimate = estimateTotal(cart);
  const [method, setMethod] = useState<PosPaymentMethod>('CASH');
  const [amount, setAmount] = useState(estimate);
  const [tendered, setTendered] = useState(estimate);
  const [customerId, setCustomerId] = useState<string | undefined>();
  const [discountOverride, setDiscountOverride] = useState<ManagerOverride | null>(null);
  const [stockOverride, setStockOverride] = useState<ManagerOverride | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function submit(retryAmount?: string) {
    setBusy(true);
    setError(undefined);
    const chargeAmount = retryAmount ?? amount;
    try {
      const sale = await posApi<Sale>('/pos/sales', {
        method: 'POST',
        body: {
          posDeviceId: device.deviceId,
          shiftId: shift.id,
          clientTxnId: crypto.randomUUID(),
          lines: cart.map((l) => ({
            variantId: l.variantId,
            quantity: l.quantity,
            ...(Number(l.discountAmount) > 0 ? { discountAmount: l.discountAmount } : {}),
          })),
          payments: [
            {
              method,
              amount: chargeAmount,
              ...(method === 'CASH' ? { tenderedAmount: tendered } : {}),
            },
          ],
          ...(customerId ? { customerId } : {}),
          ...(discountOverride ? { discountOverride } : {}),
          ...(stockOverride ? { stockOverride } : {}),
        },
      });
      onCompleted(sale);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.code === 'PAYMENT_MISMATCH' &&
        typeof err.meta.expected === 'string'
      ) {
        // The client's total was only an estimate — self-correct once against the server's figure.
        const expected = err.meta.expected;
        setAmount(expected);
        if (method === 'CASH' && Number(tendered) < Number(expected)) setTendered(expected);
        await submit(expected);
        return;
      }
      if (err instanceof ApiError && err.code === 'DISCOUNT_LIMIT_EXCEEDED' && !discountOverride) {
        setDiscountOverride({ employeeCode: '', pin: '' });
        setError(err);
      } else if (err instanceof ApiError && err.code === 'STOCK_INSUFFICIENT' && !stockOverride) {
        setStockOverride({ employeeCode: '', pin: '' });
        setError(err);
      } else {
        setError(err);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="ชำระเงิน" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-slate-500">ยอดโดยประมาณ</span>
          <span className="text-xl font-bold">{estimate} บาท</span>
        </div>
        <Field label="วิธีชำระ">
          <Select value={method} onChange={(e) => setMethod(e.target.value as PosPaymentMethod)}>
            <option value="CASH">เงินสด</option>
            <option value="PROMPTPAY">พร้อมเพย์</option>
            <option value="CREDIT_CARD">บัตรเครดิต</option>
            <option value="DEBIT_CARD">บัตรเดบิต</option>
          </Select>
        </Field>
        {method === 'CASH' ? (
          <Field label="รับเงินสด (บาท)">
            <Input value={tendered} onChange={(e) => setTendered(e.target.value)} inputMode="decimal" />
          </Field>
        ) : null}
        <Field label="ลูกค้า (ไม่บังคับ)" hint="เว้นว่างได้ถ้าเป็นลูกค้าทั่วไป">
          <CustomerPicker onSelect={setCustomerId} />
        </Field>
        {discountOverride ? (
          <ManagerOverrideFields
            label="ส่วนลดเกินสิทธิ์ — ให้ผู้จัดการอนุมัติ"
            value={discountOverride}
            onChange={setDiscountOverride}
          />
        ) : null}
        {stockOverride ? (
          <ManagerOverrideFields
            label="สต็อกไม่พอ — ผู้จัดการอนุมัติให้ขายติดลบ"
            value={stockOverride}
            onChange={setStockOverride}
          />
        ) : null}
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button busy={busy} onClick={() => void submit()}>
            ยืนยันชำระเงิน
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CustomerPicker({ onSelect }: { onSelect: (id: string | undefined) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Customer[]>([]);
  const [picked, setPicked] = useState<Customer | null>(null);

  async function search(term: string) {
    setQ(term);
    if (term.trim().length < 2) {
      setResults([]);
      return;
    }
    try {
      setResults(await posApi<Customer[]>(`/customers?q=${encodeURIComponent(term)}`));
    } catch {
      setResults([]);
    }
  }

  if (picked) {
    return (
      <div className="flex items-center justify-between rounded-md border border-slate-300 px-3 py-2 text-sm">
        <span>{picked.name}</span>
        <button
          className="text-xs text-red-600 underline"
          onClick={() => {
            setPicked(null);
            onSelect(undefined);
          }}
        >
          เอาออก
        </button>
      </div>
    );
  }
  return (
    <div>
      <Input value={q} onChange={(e) => void search(e.target.value)} placeholder="ค้นหาชื่อ/เบอร์โทร" />
      {results.length > 0 ? (
        <ul className="mt-1 max-h-32 overflow-y-auto rounded-md border border-slate-200 text-sm">
          {results.map((c) => (
            <li
              key={c.id}
              className="cursor-pointer px-3 py-1.5 hover:bg-slate-50"
              onClick={() => {
                setPicked(c);
                onSelect(c.id);
              }}
            >
              {c.name} {c.phone ? `· ${c.phone}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------- receipt

function ReceiptModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  return (
    <Modal open title={`ใบเสร็จ ${sale.orderNo}`} onClose={onClose}>
      <div id="receipt-print" className="space-y-2 text-sm">
        {sale.lines.map((l) => (
          <div key={l.orderItemId} className="flex justify-between">
            <span>
              {l.name} × {l.quantity}
            </span>
            <span>{l.lineTotal}</span>
          </div>
        ))}
        <div className="border-t border-slate-200 pt-2">
          <div className="flex justify-between text-slate-500">
            <span>ส่วนลด</span>
            <span>{sale.discountTotal}</span>
          </div>
          <div className="flex justify-between text-slate-500">
            <span>VAT</span>
            <span>{sale.taxTotal}</span>
          </div>
          <div className="flex justify-between text-lg font-bold">
            <span>ยอดสุทธิ</span>
            <span>{sale.grandTotal}</span>
          </div>
          {Number(sale.changeAmount) > 0 ? (
            <div className="flex justify-between text-slate-500">
              <span>เงินทอน</span>
              <span>{sale.changeAmount}</span>
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => window.print()}>
          พิมพ์ใบเสร็จ
        </Button>
        <Button onClick={onClose}>ขายต่อ</Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- close shift

function CloseShiftModal({
  shift,
  onClose,
  onClosed,
}: {
  shift: Shift;
  onClose: () => void;
  onClosed: () => Promise<void>;
}) {
  const [countedCash, setCountedCash] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<Shift | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const closed = await posApi<Shift>(`/pos/shifts/${shift.id}/close`, {
        method: 'POST',
        body: { countedCash },
      });
      setResult(closed);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal open title="สรุปยอดปิดกะ (Z-report)" onClose={() => void onClosed()}>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span>เงินสดคาดว่าจะมี</span>
            <span>{result.expectedCash}</span>
          </div>
          <div className="flex justify-between">
            <span>นับได้จริง</span>
            <span>{result.countedCash}</span>
          </div>
          <div className="flex justify-between font-semibold">
            <span>ผลต่าง</span>
            <span className={Number(result.cashVariance) !== 0 ? 'text-red-600' : ''}>
              {result.cashVariance}
            </span>
          </div>
          {result.summary?.byMethod ? (
            <div className="border-t border-slate-200 pt-2">
              {Object.entries(result.summary.byMethod).map(([m, v]) => (
                <div key={m} className="flex justify-between text-slate-500">
                  <span>{m}</span>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <Button className="w-full" onClick={() => void onClosed()}>
          กลับหน้าเข้าสู่ระบบ
        </Button>
      </Modal>
    );
  }

  return (
    <Modal open title="ปิดกะ" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Notice tone="info">นับเงินในลิ้นชักแล้วกรอกยอดจริง ระบบจะเทียบกับยอดที่ควรมี</Notice>
        <Field label="เงินสดที่นับได้ (บาท)">
          <Input
            value={countedCash}
            onChange={(e) => setCountedCash(e.target.value)}
            inputMode="decimal"
            required
          />
        </Field>
        <ErrorBox error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button type="submit" busy={busy}>
            ปิดกะ
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- refund

function RefundModal({
  sale,
  shiftId,
  onClose,
  onRefunded,
}: {
  sale: Sale;
  shiftId: string;
  onClose: () => void;
  onRefunded: () => void;
}) {
  const [full, setFull] = useState<Sale | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');
  const [override, setOverride] = useState<ManagerOverride | null>(null);
  const [needsOverride, setNeedsOverride] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  useEffect(() => {
    void (async () => {
      const detail = await posApi<Sale>(`/pos/sales/${sale.orderId}`);
      setFull(detail);
    })();
  }, [sale.orderId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!full) return;
    setBusy(true);
    setError(undefined);
    try {
      const lines = full.lines
        .filter((l) => Number(qty[l.orderItemId] || '0') > 0)
        .map((l) => ({
          orderItemId: l.orderItemId,
          quantity: qty[l.orderItemId]!,
          ...(restock[l.orderItemId] ? { restockCondition: 'SELLABLE' as const } : {}),
        }));
      if (lines.length === 0) throw new Error('เลือกอย่างน้อย 1 รายการ');
      await posApi(`/pos/sales/${sale.orderId}/refunds`, {
        method: 'POST',
        headers: { 'idempotency-key': `web:refund:${sale.orderId}:${Date.now()}` },
        body: { shiftId, lines, reason, ...(override ? { managerOverride: override } : {}) },
      });
      onRefunded();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'MANAGER_APPROVAL_REQUIRED' && !needsOverride) {
        setNeedsOverride(true);
        setOverride({ employeeCode: '', pin: '' });
      }
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title={`คืนเงิน — ${sale.orderNo}`} onClose={onClose}>
      {!full ? (
        <Loading />
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <div className="max-h-64 space-y-2 overflow-y-auto">
            {full.lines.map((l) => (
              <div
                key={l.orderItemId}
                className="flex items-center gap-2 border-b border-slate-100 pb-2 text-sm"
              >
                <div className="flex-1">
                  <div>{l.name}</div>
                  <div className="text-xs text-slate-500">
                    ขาย {l.quantity} ชิ้น · {l.lineTotal} บาท
                  </div>
                </div>
                <Input
                  className="w-16"
                  placeholder="0"
                  value={qty[l.orderItemId] ?? ''}
                  onChange={(e) => setQty({ ...qty, [l.orderItemId]: e.target.value })}
                />
                <label className="flex items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={restock[l.orderItemId] ?? false}
                    onChange={(e) => setRestock({ ...restock, [l.orderItemId]: e.target.checked })}
                  />
                  คืนสต็อก
                </label>
              </div>
            ))}
          </div>
          <Field label="เหตุผล">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} required />
          </Field>
          {needsOverride && override ? (
            <ManagerOverrideFields
              label="ต้องให้ผู้จัดการอนุมัติการคืนเงิน"
              value={override}
              onChange={setOverride}
            />
          ) : null}
          <ErrorBox error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button type="submit" busy={busy}>
              ยืนยันคืนเงิน
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
