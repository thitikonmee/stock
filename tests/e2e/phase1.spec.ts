import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'correct horse battery';
const run = Date.now().toString(36);

/** RFC 6238 code for a base32 secret at an absolute 30-second time step. */
function totp(base32: string, step: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of base32) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const o = hmac[hmac.length - 1]! & 15;
  return String((hmac.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/**
 * Codes are single-use and the server accepts at most one step of clock drift, so each new code
 * needs a newer step than the last one used — like a user waiting for the app to show a new code.
 */
let lastStep = 0;
async function nextCode(secret: string): Promise<string> {
  const current = () => Math.floor(Date.now() / 30_000);
  while (lastStep + 1 > current() + 1) await new Promise((r) => setTimeout(r, 500));
  lastStep = Math.max(lastStep + 1, current());
  return totp(secret, lastStep);
}

async function signup(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel('ชื่อร้าน / บริษัท').fill(`E2E Shop ${run}`);
  await page.getByLabel('ชื่อร้านสำหรับเข้าสู่ระบบ').fill(`e2e-${run}`);
  await page.getByLabel('ชื่อของคุณ').fill('เจ้าของทดสอบ');
  await page.getByLabel('อีเมล').fill(email);
  await page.getByLabel('รหัสผ่าน').fill(PASSWORD);
  await page.getByRole('button', { name: 'สร้างร้าน' }).click();
  await expect(page.getByRole('heading', { name: /สวัสดี เจ้าของทดสอบ/ })).toBeVisible();
}

test.describe.serial('Phase 1 — owner, team and devices', () => {
  const ownerEmail = `owner-${run}@e2e.test`;
  let mfaSecret = '';

  test('signup lands on the dashboard with tokens only in HttpOnly cookies', async ({ page, context }) => {
    await signup(page, ownerEmail);
    await expect(page.getByText('เริ่มต้นใช้งาน')).toBeVisible();

    const cookies = await context.cookies();
    const session = cookies.filter((c) => c.name.startsWith('so_'));
    expect(session.map((c) => c.name).sort()).toEqual(['so_at', 'so_rt']);
    for (const c of session) expect(c).toMatchObject({ httpOnly: true, sameSite: 'Strict' });
    expect(await page.evaluate(() => document.cookie)).toBe('');
  });

  test('invites a cashier who joins with limited access', async ({ page, browser }) => {
    await page.goto('/login');
    await page.getByLabel('อีเมล หรือเบอร์โทร').fill(ownerEmail);
    await page.getByLabel('รหัสผ่าน').fill(PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: /สวัสดี/ })).toBeVisible();

    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'เชิญผู้ใช้' }).click();
    const dialog = page.getByRole('dialog', { name: 'เชิญผู้ใช้' });
    await dialog.getByLabel('อีเมล').fill(`cashier-${run}@e2e.test`);
    await dialog.getByRole('button', { name: 'ส่งคำเชิญ' }).click();
    const link = await dialog.getByLabel(/ลิงก์คำเชิญ/).inputValue();
    expect(link).toContain('/invite/accept?token=');

    // The invitee uses a separate browser (no shared cookies).
    const invitee = await browser.newContext({ locale: 'th-TH' });
    const p2 = await invitee.newPage();
    await p2.goto(link);
    await p2.getByLabel('ชื่อของคุณ').fill('แคชเชียร์ทดสอบ');
    await p2.getByLabel('ตั้งรหัสผ่าน').fill('cashier password 1');
    await p2.getByRole('button', { name: 'เข้าร่วม' }).click();
    await expect(p2.getByRole('heading', { name: /สวัสดี แคชเชียร์ทดสอบ/ })).toBeVisible();

    const nav = p2.getByRole('navigation', { name: 'เมนูหลัก' });
    await expect(nav.getByRole('link', { name: 'สาขาและคลัง' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'ผู้ใช้งาน' })).toHaveCount(0);
    await p2.goto('/settings/users');
    await expect(p2.getByText('คุณไม่มีสิทธิ์เข้าหน้านี้')).toBeVisible();
    await invitee.close();

    // The owner is told that the cashier joined.
    await page.goto('/notifications');
    await expect(page.getByText(`cashier-${run}@e2e.test accepted your invitation`)).toBeVisible();
  });

  test('turns on 2FA, then dangerous actions ask for a fresh code', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('อีเมล หรือเบอร์โทร').fill(ownerEmail);
    await page.getByLabel('รหัสผ่าน').fill(PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: /สวัสดี/ })).toBeVisible();

    await page.goto('/settings/security');
    await page.getByRole('button', { name: 'ตั้งค่า 2FA' }).click();
    await expect(page.getByRole('img', { name: /QR code/ })).toBeVisible();
    mfaSecret = (await page.locator('code').textContent())!.trim();
    await page
      .getByRole('main')
      .getByLabel('รหัสยืนยัน')
      .fill(await nextCode(mfaSecret));
    await page.getByRole('button', { name: 'ยืนยันและเปิดใช้งาน' }).click();
    await expect(page.getByText('เปิดการยืนยันตัวตน 2 ขั้นตอนเรียบร้อยแล้ว')).toBeVisible();

    // Password-only session: inviting is dangerous → step-up dialog, then the request retries.
    await page.goto('/settings/users');
    await page.getByRole('button', { name: 'เชิญผู้ใช้' }).click();
    const invite = page.getByRole('dialog', { name: 'เชิญผู้ใช้' });
    await invite.getByLabel('อีเมล').fill(`manager-${run}@e2e.test`);
    await invite.getByRole('button', { name: 'ส่งคำเชิญ' }).click();
    const stepUp = page.getByRole('dialog', { name: 'ยืนยันด้วยรหัส 2FA' });
    await expect(stepUp).toBeVisible();
    await stepUp.getByLabel('รหัสยืนยัน').fill(await nextCode(mfaSecret));
    await stepUp.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(invite.getByText('ส่งอีเมลคำเชิญแล้ว')).toBeVisible();
  });

  test('login now requires the 2FA code', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('อีเมล หรือเบอร์โทร').fill(ownerEmail);
    await page.getByLabel('รหัสผ่าน').fill(PASSWORD);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page.getByRole('heading', { name: 'ยืนยันตัวตน 2 ขั้นตอน' })).toBeVisible();

    await page.getByLabel('รหัสยืนยัน').fill('000000');
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByText('รหัสยืนยันไม่ถูกต้องหรือถูกใช้ไปแล้ว')).toBeVisible();

    await page.getByLabel('รหัสยืนยัน').fill(await nextCode(mfaSecret));
    await page.getByRole('button', { name: 'ยืนยัน' }).click();
    await expect(page.getByRole('heading', { name: /สวัสดี/ })).toBeVisible();

    // A fresh 2FA login may create a POS device right away.
    await page.goto('/settings/devices');
    await page.getByRole('button', { name: 'เพิ่มเครื่อง' }).click();
    const dialog = page.getByRole('dialog', { name: 'เพิ่มเครื่อง POS' });
    await dialog.getByLabel('รหัสเครื่อง').fill('POS01');
    await dialog.getByLabel('ชื่อ').fill('เคาน์เตอร์ 1');
    await dialog.getByRole('button', { name: 'สร้างเครื่อง' }).click();
    await expect(page.getByText(/^[2-9A-Z]{5}-[2-9A-Z]{5}$/)).toBeVisible();
    await page.getByRole('button', { name: 'เสร็จสิ้น' }).click();
    await expect(page.getByRole('cell', { name: 'POS01' })).toBeVisible();

    await page.getByRole('button', { name: 'ออกจากระบบ' }).click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
