import { ApiError } from './api';

/** Thai messages for API error codes. Unknown codes fall back to the server's detail. */
const MESSAGES: Record<string, string> = {
  INVALID_CREDENTIALS: 'อีเมล/เบอร์โทร หรือรหัสผ่านไม่ถูกต้อง',
  ACCOUNT_LOCKED: 'ใส่รหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว ลองใหม่ภายหลัง',
  INVALID_MFA_CODE: 'รหัสยืนยันไม่ถูกต้องหรือถูกใช้ไปแล้ว',
  RATE_LIMITED: 'ทำรายการบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่',
  DUPLICATE: 'ข้อมูลนี้มีอยู่แล้ว',
  VALIDATION_FAILED: 'ข้อมูลไม่ถูกต้อง กรุณาตรวจสอบอีกครั้ง',
  PRIVILEGE_ESCALATION: 'คุณไม่สามารถให้สิทธิ์ที่ตัวเองไม่มี หรือแก้สิทธิ์ของตัวเอง/เจ้าของได้',
  FORBIDDEN: 'คุณไม่มีสิทธิ์ทำรายการนี้',
  PLAN_LIMIT_EXCEEDED: 'เกินจำนวนที่แพ็กเกจปัจจุบันรองรับ กรุณาอัปเกรดแพ็กเกจ',
  PRECONDITION_FAILED: 'ข้อมูลถูกแก้ไขโดยคนอื่นระหว่างนี้ กรุณาโหลดใหม่แล้วลองอีกครั้ง',
  SYSTEM_ROLE_IMMUTABLE: 'บทบาทของระบบแก้ไขไม่ได้ ให้สร้างบทบาทใหม่แทน',
  TENANT_SELECTION_REQUIRED: 'บัญชีนี้อยู่หลายบริษัท กรุณาเลือกบริษัท',
  UNAUTHENTICATED: 'ลิงก์หรือรหัสไม่ถูกต้อง หรือหมดอายุแล้ว',
  CSRF_REJECTED: 'คำขอถูกบล็อกเพื่อความปลอดภัย กรุณาโหลดหน้าใหม่',
  PRODUCT_HAS_STOCK: 'ลบไม่ได้เพราะยังมีสต็อกคงเหลือ ให้ปรับสต็อกเป็น 0 ก่อน',
  NOT_A_BUNDLE: 'สินค้านี้ไม่ใช่ประเภทชุด (Bundle)',
  NOT_FOUND: 'ไม่พบข้อมูล',
  SHIFT_ALREADY_OPEN: 'เครื่องนี้เปิดกะอยู่แล้ว',
  SHIFT_NOT_OPEN: 'ยังไม่ได้เปิดกะ',
  STOCK_INSUFFICIENT: 'สต็อกไม่พอ',
  DISCOUNT_LIMIT_EXCEEDED: 'ส่วนลดเกินสิทธิ์ ต้องให้ผู้จัดการอนุมัติ',
  MANAGER_APPROVAL_REQUIRED: 'ต้องให้ผู้จัดการอนุมัติรายการนี้',
  PAYMENT_MISMATCH: 'ยอดชำระไม่ตรงกับยอดบิล',
  REFUND_EXCEEDS_SOLD: 'จำนวนที่คืนเกินกว่าที่ขายไป',
  REFUND_EXCEEDS_PAYMENT: 'ยอดคืนเงินเกินยอดที่ชำระไว้',
  DEVICE_NOT_ACTIVE: 'เครื่องนี้ยังไม่ได้ลงทะเบียน หรือถูกปิดใช้งาน',
  VARIANT_NOT_SELLABLE: 'สินค้านี้ขายไม่ได้ในขณะนี้',
};

export function messageFor(error: unknown): string {
  if (error instanceof ApiError) return MESSAGES[error.code] ?? (error.detail || 'เกิดข้อผิดพลาด');
  return 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่';
}
