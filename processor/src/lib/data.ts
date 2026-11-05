// Spreadsheet readers for the UI iframe: CSV/TSV (RFC 4180) and XLSX (Office Open XML).
import { strFromU8, unzipSync } from 'fflate';

export interface Table {
  headers: string[];
  rows: string[][];
}

export interface Workbook {
  fileName: string;
  sheets: Array<{ name: string; table: Table }>;
}

/** First row becomes headers; blanks/dupes get unique names; empty trailing rows are dropped. */
function toTable(grid: string[][]): Table {
  const rows = grid.filter((r) => r.some((c) => c.trim() !== ''));
  const head = rows.shift() ?? [];
  const width = Math.max(head.length, ...rows.map((r) => r.length), 0);
  const seen = new Map<string, number>();
  const headers = Array.from({ length: width }, (_, i) => {
    const base = (head[i] ?? '').trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base} (${n})` : base;
  });
  return { headers, rows: rows.map((r) => headers.map((_, i) => r[i] ?? '')) };
}

export class CsvReader {
  static detectDelimiter(text: string): string {
    const line = text.slice(0, 4000).split(/\r?\n/)[0] ?? '';
    const unquoted = line.replace(/"[^"]*"/g, '');
    const counts = [',', ';', '\t', '|'].map((d) => [d, unquoted.split(d).length - 1] as const);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
  }

  static parse(text: string): Table {
    const src = text.replace(/^\uFEFF/, '');
    const d = CsvReader.detectDelimiter(src);
    const grid: string[][] = [];
    let row: string[] = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"' && src[i + 1] === '"') {
          cell += '"';
          i++;
        } else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === d) {
        row.push(cell);
        cell = '';
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && src[i + 1] === '\n') i++;
        row.push(cell);
        grid.push(row);
        row = [];
        cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) {
      row.push(cell);
      grid.push(row);
    }
    return toTable(grid);
  }
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

export class XlsxReader {
  private readonly files: Record<string, Uint8Array>;
  private readonly parser = new DOMParser();
  private sharedStrings: string[] = [];
  private dateStyles = new Set<number>();

  constructor(bytes: Uint8Array) {
    this.files = unzipSync(bytes, {
      filter: (f) =>
        (f.name.startsWith('xl/') && f.name.endsWith('.xml')) || f.name.endsWith('.rels'),
    });
  }

  private xml(path: string): Document | null {
    const f = this.files[path];
    return f ? this.parser.parseFromString(strFromU8(f), 'application/xml') : null;
  }

  private static all(root: Document | Element, tag: string): Element[] {
    return Array.from(root.getElementsByTagNameNS('*', tag));
  }

  private loadSharedStrings(): void {
    const doc = this.xml('xl/sharedStrings.xml');
    if (!doc) return;
    this.sharedStrings = XlsxReader.all(doc, 'si').map((si) =>
      XlsxReader.all(si, 't')
        .filter((t) => t.parentElement?.localName !== 'rPh')
        .map((t) => t.textContent ?? '')
        .join(''),
    );
  }

  private loadDateStyles(): void {
    const doc = this.xml('xl/styles.xml');
    if (!doc) return;
    const custom = new Map<number, string>();
    XlsxReader.all(doc, 'numFmt').forEach((n) =>
      custom.set(Number(n.getAttribute('numFmtId')), n.getAttribute('formatCode') ?? ''),
    );
    const isDate = (id: number) => {
      if (BUILTIN_DATE_FORMATS.has(id)) return true;
      const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
      return /[dmy]/i.test(code) && !/[#0]/.test(code);
    };
    const cellXfs = XlsxReader.all(doc, 'cellXfs')[0];
    if (!cellXfs) return;
    XlsxReader.all(cellXfs, 'xf').forEach((xf, i) => {
      if (isDate(Number(xf.getAttribute('numFmtId')))) this.dateStyles.add(i);
    });
  }

  private static colIndex(ref: string): number {
    const letters = ref.replace(/\d+/g, '').toUpperCase();
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  private static formatNumber(v: string): string {
    const n = Number(v);
    return Number.isFinite(n) ? String(parseFloat(n.toPrecision(15))) : v;
  }

  private static formatDate(serial: number): string {
    const ms = Math.round((serial - 25569) * 86400 * 1000);
    const d = new Date(ms);
    const iso = d.toISOString();
    return serial % 1 === 0 ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }

  private cellValue(c: Element): string {
    const t = c.getAttribute('t');
    const v = XlsxReader.all(c, 'v')[0]?.textContent ?? '';
    if (t === 's') return this.sharedStrings[Number(v)] ?? '';
    if (t === 'inlineStr')
      return XlsxReader.all(c, 't')
        .map((x) => x.textContent ?? '')
        .join('');
    if (t === 'b') return v === '1' ? 'TRUE' : 'FALSE';
    if (t === 'str' || t === 'e') return v;
    if (v === '') return '';
    const style = Number(c.getAttribute('s') ?? -1);
    if (this.dateStyles.has(style)) return XlsxReader.formatDate(Number(v));
    return XlsxReader.formatNumber(v);
  }

  private readSheet(path: string): Table {
    const doc = this.xml(path);
    if (!doc) return { headers: [], rows: [] };
    const grid: string[][] = [];
    XlsxReader.all(doc, 'row').forEach((rowEl, i) => {
      const r = Number(rowEl.getAttribute('r') ?? i + 1) - 1;
      const row: string[] = (grid[r] = grid[r] ?? []);
      XlsxReader.all(rowEl, 'c').forEach((c, j) => {
        const ref = c.getAttribute('r');
        row[ref ? XlsxReader.colIndex(ref) : j] = this.cellValue(c);
      });
    });
    const dense = Array.from(grid, (r) => Array.from(r ?? [], (c) => c ?? ''));
    return toTable(dense);
  }

  read(fileName: string): Workbook {
    const wb = this.xml('xl/workbook.xml');
    if (!wb) throw new Error('Not a valid .xlsx file.');
    this.loadSharedStrings();
    this.loadDateStyles();
    const rels = new Map<string, string>();
    const relDoc = this.xml('xl/_rels/workbook.xml.rels');
    if (relDoc) {
      XlsxReader.all(relDoc, 'Relationship').forEach((r) => {
        const target = (r.getAttribute('Target') ?? '').replace(/^\/?(xl\/)?/, '');
        rels.set(r.getAttribute('Id') ?? '', `xl/${target}`);
      });
    }
    const sheets = XlsxReader.all(wb, 'sheet').map((s, i) => {
      const rid =
        s.getAttribute('r:id') ??
        s.getAttributeNS(
          'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
          'id',
        ) ??
        '';
      const path = rels.get(rid) ?? `xl/worksheets/sheet${i + 1}.xml`;
      return { name: s.getAttribute('name') ?? `Sheet ${i + 1}`, table: this.readSheet(path) };
    });
    return { fileName, sheets };
  }
}

export async function readDataFile(file: File): Promise<Workbook> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return new XlsxReader(bytes).read(file.name);
  if (/\.xls$/i.test(file.name) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) {
    throw new Error('Legacy .xls isn’t supported — save it as .xlsx or .csv.');
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  return { fileName: file.name, sheets: [{ name: 'Data', table: CsvReader.parse(text) }] };
}
