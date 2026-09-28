import { ValidationError } from '@stockos/shared';

export type BarcodeSymbology = 'EAN13' | 'EAN8' | 'UPCA' | 'UPCE' | 'CODE128' | 'QR' | 'INTERNAL';

/** GS1 range reserved for in-store use (never assigned to a real manufacturer) — docs/08-api-design.md. */
export const INTERNAL_EAN13_PREFIXES = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'] as const;

/** Standard EAN/UPC (GS1) mod-10 check digit over the digits to its left. */
export function ean13CheckDigit(twelveDigits: string): string {
  if (!/^\d{12}$/.test(twelveDigits)) throw new ValidationError('Expected 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const digit = Number(twelveDigits[i]);
    sum += i % 2 === 0 ? digit : digit * 3;
  }
  return String((10 - (sum % 10)) % 10);
}

/** Build a full, valid EAN-13 from a 2-digit internal prefix (20-29) + an unpadded running number. */
export function buildInternalEan13(prefix: string, runningNumber: number | bigint): string {
  if (!(INTERNAL_EAN13_PREFIXES as readonly string[]).includes(prefix)) {
    throw new ValidationError('Internal EAN-13 prefix must be 20-29');
  }
  const body = String(runningNumber);
  if (body.length > 10) throw new ValidationError('Barcode running number exhausted (10 digits)');
  const twelve = prefix + body.padStart(10, '0');
  return twelve + ean13CheckDigit(twelve);
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === code[12];
}

const CODE128_RE = /^[\x20-\x7e]{1,48}$/; // printable ASCII, Code 128 subset B range used by bwip-js

export function isValidCode128(code: string): boolean {
  return CODE128_RE.test(code);
}

/** Validate a barcode value against the symbology it is being registered as. */
export function assertValidBarcode(symbology: BarcodeSymbology, code: string): void {
  switch (symbology) {
    case 'EAN13':
      if (!isValidEan13(code)) throw new ValidationError('Invalid EAN-13 (bad length or check digit)');
      return;
    case 'EAN8':
      if (!/^\d{8}$/.test(code)) throw new ValidationError('EAN-8 must be 8 digits');
      return;
    case 'UPCA':
      if (!/^\d{12}$/.test(code)) throw new ValidationError('UPC-A must be 12 digits');
      return;
    case 'UPCE':
      if (!/^\d{6,8}$/.test(code)) throw new ValidationError('UPC-E must be 6-8 digits');
      return;
    case 'CODE128':
      if (!isValidCode128(code)) throw new ValidationError('Code 128 must be 1-48 printable ASCII chars');
      return;
    case 'QR':
    case 'INTERNAL':
      if (!code.trim() || code.length > 128) throw new ValidationError('Invalid barcode value');
      return;
  }
}

/** bwip-js `bcid` for a symbology (docs/03-database.md variant_barcodes.symbology). */
export function bwipBcid(symbology: BarcodeSymbology): string {
  const map: Record<BarcodeSymbology, string> = {
    EAN13: 'ean13',
    EAN8: 'ean8',
    UPCA: 'upca',
    UPCE: 'upce',
    CODE128: 'code128',
    QR: 'qrcode',
    INTERNAL: 'code128',
  };
  return map[symbology];
}
