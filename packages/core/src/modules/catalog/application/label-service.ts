import bwipjs from 'bwip-js';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { ValidationError } from '@stockos/shared';
import { bwipBcid, type BarcodeSymbology } from '../domain/barcode';

export interface LabelItem {
  barcode: string;
  symbology: BarcodeSymbology;
  sku: string;
  name: string;
  price: string;
  quantity: number;
}

const MAX_LABELS = 500;
// A common 3x8 address-label sheet (A4, ~70x33.9mm cells) — good enough for a shop's barcode gun.
const PAGE = { width: 595.28, height: 841.89 }; // A4 pt
const COLS = 3;
const ROWS = 8;
const MARGIN = 14;
const CELL_W = (PAGE.width - MARGIN * 2) / COLS;
const CELL_H = (PAGE.height - MARGIN * 2) / ROWS;

/** Render a sheet of barcode labels (SKU, name, price, barcode image) as a PDF buffer. */
export async function renderLabelSheet(items: LabelItem[]): Promise<Uint8Array> {
  const total = items.reduce((n, i) => n + i.quantity, 0);
  if (total === 0) throw new ValidationError('No labels to print');
  if (total > MAX_LABELS) throw new ValidationError(`At most ${MAX_LABELS} labels per sheet`);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const cells: LabelItem[] = [];
  for (const item of items) for (let i = 0; i < item.quantity; i++) cells.push(item);

  const barcodePngCache = new Map<string, Uint8Array>();
  let page = doc.addPage([PAGE.width, PAGE.height]);
  for (let i = 0; i < cells.length; i++) {
    const posInPage = i % (COLS * ROWS);
    if (i > 0 && posInPage === 0) page = doc.addPage([PAGE.width, PAGE.height]);
    const col = posInPage % COLS;
    const row = Math.floor(posInPage / COLS);
    const x = MARGIN + col * CELL_W;
    const yTop = PAGE.height - MARGIN - row * CELL_H;
    await drawLabel(doc, page, cells[i]!, { x, yTop, w: CELL_W, h: CELL_H }, font, bold, barcodePngCache);
  }
  return doc.save();
}

async function drawLabel(
  doc: PDFDocument,
  page: Awaited<ReturnType<PDFDocument['addPage']>>,
  item: LabelItem,
  box: { x: number; yTop: number; w: number; h: number },
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  bold: Awaited<ReturnType<PDFDocument['embedFont']>>,
  cache: Map<string, Uint8Array>,
): Promise<void> {
  const pad = 6;
  const innerW = box.w - pad * 2;

  // Product name: standard fonts only cover WinAnsi (no Thai glyphs). Draw what encodes cleanly and
  // drop the rest rather than crash the whole sheet — SKU/barcode/price below still print.
  const safeName = toWinAnsiSafe(item.name);
  if (safeName) {
    page.drawText(truncateToWidth(safeName, font, 8, innerW), {
      x: box.x + pad,
      y: box.yTop - 12,
      size: 8,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }
  page.drawText(item.sku, {
    x: box.x + pad,
    y: box.yTop - 22,
    size: 7,
    font,
    color: rgb(0.35, 0.35, 0.35),
  });
  // WinAnsi (StandardFonts.Helvetica) cannot encode "฿" (U+0E3F) — spell out the currency instead.
  page.drawText(`THB ${item.price}`, {
    x: box.x + pad,
    y: box.yTop - box.h + 10,
    size: 9,
    font: bold,
    color: rgb(0, 0, 0),
  });

  const cacheKey = `${item.symbology}:${item.barcode}`;
  let png = cache.get(cacheKey);
  if (!png) {
    png = await bwipjs.toBuffer({
      bcid: bwipBcid(item.symbology),
      text: item.barcode,
      includetext: true,
      textxalign: 'center',
      scale: 2,
      height: 10,
    });
    cache.set(cacheKey, png);
  }
  const image = await doc.embedPng(png);
  const maxImgW = innerW;
  const maxImgH = box.h - 34;
  const ratio = Math.min(maxImgW / image.width, maxImgH / image.height);
  const w = image.width * ratio;
  const h = image.height * ratio;
  page.drawImage(image, {
    x: box.x + (box.w - w) / 2,
    y: box.yTop - box.h + 16,
    width: w,
    height: h,
  });
}

/** WinAnsi (Latin-1-ish) only; strip anything StandardFonts.Helvetica cannot encode (e.g. Thai). */
function toWinAnsiSafe(text: string): string {
  return text.replace(/[^\x20-\x7e]/g, '').trim();
}

function truncateToWidth(
  text: string,
  font: Awaited<ReturnType<PDFDocument['embedFont']>>,
  size: number,
  maxWidth: number,
): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxWidth) out = out.slice(0, -1);
  return out + '…';
}
