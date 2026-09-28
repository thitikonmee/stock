import { createTransport, type Transporter } from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Outbound e-mail. Implementations must not throw for "user errors" — callers treat sending as best-effort. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean;
  user?: string;
  password?: string;
  from: string;
}

export class SmtpEmailSender implements EmailSender {
  private readonly transport: Transporter;

  constructor(private readonly config: SmtpConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure ?? config.port === 465,
      ...(config.user ? { auth: { user: config.user, pass: config.password ?? '' } } : {}),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.from, ...message });
  }
}

/** Keeps messages in memory (tests, local runs without SMTP). */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
}

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Invitation e-mail (Thai first, English second). All interpolated values are HTML-escaped. */
export function invitationEmail(input: {
  to: string;
  companyName: string;
  inviterName: string;
  acceptUrl: string;
  expiresAt: Date;
}): EmailMessage {
  const expires = input.expiresAt.toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const subject = `${input.inviterName} เชิญคุณเข้าร่วม ${input.companyName} บน StockOS`;
  const text = [
    `${input.inviterName} เชิญคุณเข้าร่วม ${input.companyName} บน StockOS`,
    `กดลิงก์นี้เพื่อตอบรับ (หมดอายุ ${expires}):`,
    input.acceptUrl,
    '',
    `${input.inviterName} invited you to join ${input.companyName} on StockOS.`,
    `Accept: ${input.acceptUrl}`,
    '',
    'ถ้าคุณไม่ได้คาดว่าจะได้รับอีเมลนี้ ให้เพิกเฉยได้เลย / If you were not expecting this, ignore this e-mail.',
  ].join('\n');
  const html = `<!doctype html><html lang="th"><body style="font-family:sans-serif;line-height:1.6;color:#111">
<p><strong>${escape(input.inviterName)}</strong> เชิญคุณเข้าร่วม <strong>${escape(input.companyName)}</strong> บน StockOS</p>
<p><a href="${escape(input.acceptUrl)}" style="display:inline-block;padding:10px 18px;background:#0f766e;color:#fff;border-radius:6px;text-decoration:none">ตอบรับคำเชิญ / Accept invitation</a></p>
<p style="color:#555;font-size:13px">ลิงก์หมดอายุ ${escape(expires)} · ถ้าคุณไม่ได้คาดว่าจะได้รับอีเมลนี้ ให้เพิกเฉยได้เลย</p>
</body></html>`;
  return { to: input.to, subject, text, html };
}
