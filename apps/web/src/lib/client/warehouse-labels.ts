import type { CountStatus, CountType, LocationLevel, PurchaseStatus, TransferStatus } from './types';

type Tone = 'amber' | 'green' | 'red' | 'slate' | 'teal';

export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'แบบร่าง', tone: 'slate' },
  PENDING_APPROVAL: { label: 'รออนุมัติ', tone: 'amber' },
  APPROVED: { label: 'อนุมัติแล้ว', tone: 'teal' },
  SENT: { label: 'ส่งให้ผู้ขายแล้ว', tone: 'teal' },
  PARTIALLY_RECEIVED: { label: 'รับของบางส่วน', tone: 'amber' },
  RECEIVED: { label: 'รับครบแล้ว', tone: 'green' },
  CLOSED: { label: 'ปิดแล้ว', tone: 'slate' },
  CANCELLED: { label: 'ยกเลิก', tone: 'red' },
};

export const TRANSFER_STATUS: Record<TransferStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'แบบร่าง', tone: 'slate' },
  REQUESTED: { label: 'รออนุมัติ', tone: 'amber' },
  APPROVED: { label: 'อนุมัติแล้ว (กันสต็อก)', tone: 'teal' },
  PICKING: { label: 'กำลังหยิบ', tone: 'teal' },
  SHIPPED: { label: 'กำลังขนส่ง', tone: 'amber' },
  PARTIALLY_RECEIVED: { label: 'รับบางส่วน', tone: 'amber' },
  RECEIVED: { label: 'รับครบแล้ว', tone: 'green' },
  COMPLETED: { label: 'เสร็จสิ้น', tone: 'green' },
  CANCELLED: { label: 'ยกเลิก', tone: 'red' },
};

export const COUNT_STATUS: Record<CountStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'แบบร่าง', tone: 'slate' },
  IN_PROGRESS: { label: 'กำลังนับ', tone: 'teal' },
  SUBMITTED: { label: 'ส่งแล้ว', tone: 'amber' },
  PENDING_APPROVAL: { label: 'รออนุมัติ', tone: 'amber' },
  APPROVED: { label: 'อนุมัติแล้ว', tone: 'green' },
  POSTED: { label: 'ปรับสต็อกแล้ว', tone: 'green' },
  CANCELLED: { label: 'ยกเลิก', tone: 'red' },
};

export const COUNT_TYPE: Record<CountType, string> = {
  FULL: 'นับทั้งคลัง',
  CYCLE: 'นับหมุนเวียน',
  BLIND: 'นับแบบไม่เห็นยอด',
  SPOT: 'นับเฉพาะรายการ',
};

export const LOCATION_LEVEL: Record<LocationLevel, string> = {
  ZONE: 'โซน',
  RACK: 'ชั้นวาง (Rack)',
  SHELF: 'ชั้น (Shelf)',
  BIN: 'ช่อง (Bin)',
};

/** Thai baht with 2 decimals. */
export const baht = (v: string | number) =>
  `฿${Number(v).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Quantity without trailing ".000". */
export const qty = (v: string | null | undefined) =>
  v === null || v === undefined ? '—' : Number(v).toLocaleString('th-TH', { maximumFractionDigits: 3 });

/** If-Match header for an optimistic-locked document. */
export const ifMatch = (version: number) => ({ 'if-match': `"v${version}"` });

/** One fresh idempotency key per user action (a retried click reuses the same key). */
export const newKey = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
