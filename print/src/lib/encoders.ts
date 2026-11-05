// Print file encoders that run in the UI iframe: DPI metadata for PNG/JPG, CMYK TIFF and CMYK PDF.
import { zlibSync } from 'fflate';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const ascii = (s: string) => new TextEncoder().encode(s);

export class DpiTagger {
  /** Replaces/inserts the PNG pHYs chunk (pixels per metre). */
  static png(bytes: Uint8Array, dpi: number): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts: Uint8Array[] = [bytes.subarray(0, 8)];
    let offset = 8;
    let inserted = false;
    while (offset < bytes.length) {
      const len = view.getUint32(offset);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      const end = offset + 12 + len;
      if (type !== 'pHYs') parts.push(bytes.subarray(offset, end));
      if (type === 'IHDR' && !inserted) {
        parts.push(DpiTagger.physChunk(dpi));
        inserted = true;
      }
      offset = end;
    }
    return concat(parts);
  }

  private static physChunk(dpi: number): Uint8Array {
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(21);
    const v = new DataView(chunk.buffer);
    v.setUint32(0, 9);
    chunk.set(ascii('pHYs'), 4);
    v.setUint32(8, ppm);
    v.setUint32(12, ppm);
    chunk[16] = 1; // unit: metre
    v.setUint32(17, crc32(chunk.subarray(4, 17)));
    return chunk;
  }

  /** Sets JFIF density (dots per inch), inserting an APP0 segment when the file has none. */
  static jpg(bytes: Uint8Array, dpi: number): Uint8Array {
    const d = Math.min(65535, Math.round(dpi));
    const isJfif =
      bytes[2] === 0xff &&
      bytes[3] === 0xe0 &&
      String.fromCharCode(...bytes.subarray(6, 10)) === 'JFIF';
    if (isJfif) {
      const out = new Uint8Array(bytes);
      const v = new DataView(out.buffer);
      out[13] = 1;
      v.setUint16(14, d);
      v.setUint16(16, d);
      return out;
    }
    const app0 = new Uint8Array([
      0xff,
      0xe0,
      0x00,
      0x10,
      0x4a,
      0x46,
      0x49,
      0x46,
      0x00,
      0x01,
      0x02,
      0x01,
      d >> 8,
      d & 0xff,
      d >> 8,
      d & 0xff,
      0x00,
      0x00,
    ]);
    return concat([bytes.subarray(0, 2), app0, bytes.subarray(2)]);
  }
}

export interface CmykImage {
  width: number;
  height: number;
  data: Uint8Array; // C,M,Y,K per pixel, 0 = no ink
}

export class CmykConverter {
  /** Decodes a PNG and converts it to device CMYK (alpha composited over white, no ICC profile). */
  static async fromPng(png: Uint8Array): Promise<CmykImage> {
    const bitmap = await createImageBitmap(new Blob([png as BlobPart], { type: 'image/png' }));
    const { width, height } = bitmap;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const out = new Uint8Array(canvas.width * canvas.height * 4);
    for (let i = 0; i < rgba.length; i += 4) {
      const r = rgba[i] / 255;
      const g = rgba[i + 1] / 255;
      const b = rgba[i + 2] / 255;
      const k = 1 - Math.max(r, g, b);
      const inv = k < 1 ? 1 / (1 - k) : 0;
      out[i] = Math.round((1 - r - k) * inv * 255);
      out[i + 1] = Math.round((1 - g - k) * inv * 255);
      out[i + 2] = Math.round((1 - b - k) * inv * 255);
      out[i + 3] = Math.round(k * 255);
    }
    canvas.width = canvas.height = 0; // release backing store
    return { width, height, data: out };
  }
}

export class CmykTiff {
  /** Single-strip, Deflate-compressed (8) CMYK TIFF with resolution tags. */
  static encode(img: CmykImage, dpi: number): Uint8Array {
    const pixels = zlibSync(img.data, { level: 6 });
    const tags: Array<[number, number, number, number]> = []; // tag, type, count, value/offset
    const IFD = 8;
    const entries = 15;
    const extra = IFD + 2 + entries * 12 + 4; // bits(8) xres(8) yres(8) then pixels
    const bitsOff = extra;
    const xresOff = extra + 8;
    const yresOff = extra + 16;
    const dataOff = extra + 24;
    const SHORT = 3;
    const LONG = 4;
    const RATIONAL = 5;
    tags.push(
      [256, LONG, 1, img.width],
      [257, LONG, 1, img.height],
      [258, SHORT, 4, bitsOff],
      [259, SHORT, 1, 8],
      [262, SHORT, 1, 5],
      [273, LONG, 1, dataOff],
      [277, SHORT, 1, 4],
      [278, LONG, 1, img.height],
      [279, LONG, 1, pixels.length],
      [282, RATIONAL, 1, xresOff],
      [283, RATIONAL, 1, yresOff],
      [284, SHORT, 1, 1],
      [296, SHORT, 1, 2],
      [305, 2, 4, 0x00676946], // Software "Fig\0" (ASCII inline)
      [332, SHORT, 1, 1],
    );
    const head = new Uint8Array(dataOff);
    const v = new DataView(head.buffer);
    head.set([0x49, 0x49, 42, 0]); // "II*\0"
    v.setUint32(4, IFD, true);
    v.setUint16(IFD, entries, true);
    tags.forEach(([tag, type, count, value], i) => {
      const o = IFD + 2 + i * 12;
      v.setUint16(o, tag, true);
      v.setUint16(o + 2, type, true);
      v.setUint32(o + 4, count, true);
      if (type === SHORT && count === 1) v.setUint16(o + 8, value, true);
      else v.setUint32(o + 8, value, true);
    });
    v.setUint32(IFD + 2 + entries * 12, 0, true); // no next IFD
    for (let i = 0; i < 4; i++) v.setUint16(bitsOff + i * 2, 8, true);
    const d = Math.round(dpi);
    v.setUint32(xresOff, d, true);
    v.setUint32(xresOff + 4, 1, true);
    v.setUint32(yresOff, d, true);
    v.setUint32(yresOff + 4, 1, true);
    return concat([head, pixels]);
  }
}

export class CmykPdf {
  /** One-page PDF whose page is exactly the print size, filled by a DeviceCMYK image. */
  static encode(img: CmykImage, widthIn: number, heightIn: number): Uint8Array {
    const w = +(widthIn * 72).toFixed(3);
    const h = +(heightIn * 72).toFixed(3);
    const pixels = zlibSync(img.data, { level: 6 });
    const content = ascii(`q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n`);

    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let size = 0;
    const push = (b: Uint8Array) => {
      chunks.push(b);
      size += b.length;
    };
    const obj = (n: number, body: Uint8Array[]) => {
      offsets[n] = size;
      push(ascii(`${n} 0 obj\n`));
      body.forEach(push);
      push(ascii('\nendobj\n'));
    };

    push(ascii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
    obj(1, [ascii('<< /Type /Catalog /Pages 2 0 R >>')]);
    obj(2, [ascii('<< /Type /Pages /Kids [3 0 R] /Count 1 >>')]);
    obj(3, [
      ascii(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /TrimBox [0 0 ${w} ${h}] ` +
          '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
      ),
    ]);
    obj(4, [ascii(`<< /Length ${content.length} >>\nstream\n`), content, ascii('endstream')]);
    obj(5, [
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
          `/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode /Length ${pixels.length} >>\nstream\n`,
      ),
      pixels,
      ascii('\nendstream'),
    ]);

    const xref = size;
    const rows = offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`);
    push(
      ascii(
        `xref\n0 ${offsets.length}\n0000000000 65535 f \n${rows.join('')}` +
          `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      ),
    );
    return concat(chunks);
  }
}
