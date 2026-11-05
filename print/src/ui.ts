import { zipSync } from 'fflate';
import {
  $,
  Choice,
  Status,
  download,
  esc,
  onPluginMessage,
  post,
  safeFilename,
  wireShell,
} from '../../shared/ui-kit';
import { CmykConverter, CmykPdf, CmykTiff, DpiTagger } from './lib/encoders';
import {
  MM_PER_IN,
  type CodeToUi,
  type ColorMode,
  type ExportFormat,
  type ExportedFile,
  type FrameInfo,
  type UiToCode,
  type Unit,
} from './types';

wireShell();
const send = (m: UiToCode) => post(m);
const status = new Status($('status'));
const goBtn = $<HTMLButtonElement>('go');

/* ---------- Helpers ---------- */
const MM_PER: Record<Unit, number> = { mm: 1, cm: 10, in: MM_PER_IN };
const fmt = (mm: number, u: Unit) => String(+(mm / MM_PER[u]).toFixed(u === 'mm' ? 1 : 2));
const num = (el: HTMLInputElement) => parseFloat(el.value.replace(',', '.'));

function fillSelect(el: HTMLSelectElement, options: Array<[string, string]>, value: string): void {
  el.innerHTML = options.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
  el.value = options.some(([v]) => v === value) ? value : options[0][0];
}

const DPIS: Array<[string, string]> = [72, 96, 150, 300, 600].map((d) => [String(d), `${d} dpi`]);

/* ---------- Tabs ---------- */
type Tab = 'insert' | 'export';
const tabs = new Choice<Tab>($('tabs'), 'insert');
tabs.onChange((t) => {
  $('insertView').classList.toggle('hidden', t !== 'insert');
  $('exportView').classList.toggle('hidden', t !== 'export');
  status.clear();
  refreshButton();
});

/* ---------- Insert ---------- */
const PRESETS: Array<{ id: string; name: string; w: number; h: number }> = [
  { id: 'a3', name: 'A3', w: 297, h: 420 },
  { id: 'a4', name: 'A4', w: 210, h: 297 },
  { id: 'a5', name: 'A5', w: 148, h: 210 },
  { id: 'a6', name: 'A6', w: 105, h: 148 },
  { id: 'letter', name: 'US Letter', w: 215.9, h: 279.4 },
  { id: 'legal', name: 'US Legal', w: 215.9, h: 355.6 },
  { id: 'tabloid', name: 'Tabloid', w: 279.4, h: 431.8 },
  { id: 'card', name: 'Business card', w: 88.9, h: 50.8 },
  { id: 'postcard', name: 'Postcard', w: 101.6, h: 152.4 },
  { id: 'poster', name: 'Poster 18×24 in', w: 457.2, h: 609.6 },
];

const presetSel = $<HTMLSelectElement>('preset');
const unitSel = $<HTMLSelectElement>('unit');
const dpiSel = $<HTMLSelectElement>('dpi');
const wIn = $<HTMLInputElement>('w');
const hIn = $<HTMLInputElement>('h');
let sizeMm = { w: 210, h: 297 };

fillSelect(
  presetSel,
  [...PRESETS.map((p): [string, string] => [p.id, p.name]), ['custom', 'Custom']],
  'a4',
);
fillSelect(dpiSel, DPIS, '300');

const unit = () => unitSel.value as Unit;
const dpi = () => parseInt(dpiSel.value, 10);

function renderInsert(): void {
  if (document.activeElement !== wIn) wIn.value = fmt(sizeMm.w, unit());
  if (document.activeElement !== hIn) hIn.value = fmt(sizeMm.h, unit());
  const px = (mm: number) => Math.round((mm / MM_PER_IN) * dpi());
  const ok = sizeMm.w > 0 && sizeMm.h > 0;
  $('pxOut').innerHTML = ok ? `Frame: <b>${px(sizeMm.w)} × ${px(sizeMm.h)} px</b>` : 'Enter a size';
  refreshButton();
}

presetSel.addEventListener('change', () => {
  const p = PRESETS.find((x) => x.id === presetSel.value);
  if (p) {
    const landscape = sizeMm.w > sizeMm.h;
    const [a, b] = [Math.min(p.w, p.h), Math.max(p.w, p.h)];
    sizeMm = landscape || p.w > p.h ? { w: b, h: a } : { w: a, h: b };
  } else wIn.focus();
  renderInsert();
});
$('swap').addEventListener('click', () => {
  sizeMm = { w: sizeMm.h, h: sizeMm.w };
  renderInsert();
});
[unitSel, dpiSel].forEach((el) => el.addEventListener('change', renderInsert));
function onDimInput(): void {
  const w = num(wIn);
  const h = num(hIn);
  sizeMm = { w: w > 0 ? w * MM_PER[unit()] : 0, h: h > 0 ? h * MM_PER[unit()] : 0 };
  presetSel.value = 'custom';
  renderInsert();
}
[wIn, hIn].forEach((el) => {
  el.addEventListener('input', onDimInput);
  el.addEventListener('blur', renderInsert);
});

function insert(): void {
  const u = unit();
  const p = PRESETS.find((x) => x.id === presetSel.value);
  const name = `${p ? p.name : 'Print'} · ${fmt(sizeMm.w, u)} × ${fmt(sizeMm.h, u)} ${u} · ${dpi()} dpi`;
  send({
    type: 'insert',
    name,
    widthMm: +sizeMm.w.toFixed(3),
    heightMm: +sizeMm.h.toFixed(3),
    dpi: dpi(),
  });
}

/* ---------- Export ---------- */
let frames: FrameInfo[] = [];
const outDpiSel = $<HTMLSelectElement>('outDpi');
const modeSel = $<HTMLSelectElement>('mode');
const formatSel = $<HTMLSelectElement>('format');
const srcDpiSel = $<HTMLSelectElement>('srcDpi');
fillSelect(outDpiSel, DPIS, '300');
fillSelect(srcDpiSel, DPIS, '72');

const FORMATS: Record<ColorMode, Array<[ExportFormat, string]>> = {
  rgb: [
    ['png', 'PNG'],
    ['jpg', 'JPG'],
    ['pdf', 'PDF (vector)'],
  ],
  cmyk: [
    ['pdf', 'PDF'],
    ['tiff', 'TIFF'],
  ],
};

function renderExport(): void {
  fillSelect(formatSel, FORMATS[modeSel.value as ColorMode], formatSel.value);
  const out = parseInt(outDpiSel.value, 10);
  const src = parseInt(srcDpiSel.value, 10);
  const vector = modeSel.value === 'rgb' && formatSel.value === 'pdf';
  $('selCount').textContent = frames.length ? String(frames.length) : '';
  $('srcRow').classList.toggle(
    'hidden',
    frames.every((f) => f.meta),
  );
  outDpiSel.disabled = vector;
  $('frames').innerHTML = frames.length
    ? frames
        .map((f) => {
          const wInch = f.width / (f.meta?.dpi ?? src);
          const hInch = f.height / (f.meta?.dpi ?? src);
          const size = vector
            ? `${fmt(wInch * MM_PER_IN, 'mm')} × ${fmt(hInch * MM_PER_IN, 'mm')} mm`
            : `${Math.round(wInch * out)} × ${Math.round(hInch * out)} px`;
          return `<div class="frame-row"><span>${esc(f.name)}</span><span>${size}</span></div>`;
        })
        .join('')
    : '<div class="hint">Select frames on the canvas</div>';
  refreshButton();
}
[outDpiSel, modeSel, formatSel, srcDpiSel].forEach((el) =>
  el.addEventListener('change', renderExport),
);

class ExportSession {
  private queue: Promise<void> = Promise.resolve();
  private files: Record<string, Uint8Array> = {};

  constructor(
    private readonly mode: ColorMode,
    private readonly format: ExportFormat,
    private readonly dpi: number,
  ) {}

  add(file: ExportedFile): void {
    this.queue = this.queue.then(() => this.process(file));
  }

  private uniqueName(base: string, ext: string): string {
    let name = `${base}.${ext}`;
    for (let i = 2; this.files[name]; i++) name = `${base} (${i}).${ext}`;
    return name;
  }

  private async process(file: ExportedFile): Promise<void> {
    const vector = file.kind === 'pdf';
    const tag = vector ? 'vector' : `${this.dpi}dpi ${this.mode.toUpperCase()}`;
    const base = safeFilename(`${file.name} – ${tag}`);
    let bytes: Uint8Array;
    if (vector) bytes = file.bytes;
    else if (this.mode === 'rgb' && file.kind === 'jpg')
      bytes = DpiTagger.jpg(file.bytes, this.dpi);
    else if (this.mode === 'rgb') bytes = DpiTagger.png(file.bytes, this.dpi);
    else {
      const img = await CmykConverter.fromPng(file.bytes);
      bytes =
        this.format === 'tiff'
          ? CmykTiff.encode(img, this.dpi)
          : CmykPdf.encode(img, file.widthIn, file.heightIn);
    }
    this.files[this.uniqueName(base, this.format)] = bytes;
  }

  async finish(): Promise<number> {
    await this.queue;
    const names = Object.keys(this.files);
    const mime: Record<ExportFormat, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      pdf: 'application/pdf',
      tiff: 'image/tiff',
    };
    if (names.length === 1) download(this.files[names[0]], names[0], mime[this.format]);
    else if (names.length > 1) {
      download(
        zipSync(this.files, { level: 0 }),
        `Print export (${names.length}).zip`,
        'application/zip',
      );
    }
    return names.length;
  }
}

let session: ExportSession | null = null;
let busy = false;

function startExport(): void {
  const mode = modeSel.value as ColorMode;
  const format = formatSel.value as ExportFormat;
  const outDpi = parseInt(outDpiSel.value, 10);
  session = new ExportSession(mode, format, outDpi);
  busy = true;
  refreshButton();
  status.set('Exporting…');
  send({
    type: 'export',
    ids: frames.map((f) => f.id),
    fallbackDpi: parseInt(srcDpiSel.value, 10),
    outDpi,
    mode,
    format,
  });
}

/* ---------- Button ---------- */
function refreshButton(): void {
  if (tabs.get() === 'insert') {
    goBtn.textContent = 'Insert frame';
    goBtn.disabled = !(sizeMm.w > 0 && sizeMm.h > 0);
    return;
  }
  const n = frames.length;
  goBtn.textContent = busy ? 'Exporting…' : n > 1 ? `Export ${n} frames` : 'Export';
  goBtn.disabled = busy || !n;
}
goBtn.addEventListener('click', () => (tabs.get() === 'insert' ? insert() : startExport()));

/* ---------- Messages ---------- */
onPluginMessage<CodeToUi>(async (msg) => {
  switch (msg.type) {
    case 'selection':
      frames = msg.frames;
      renderExport();
      break;
    case 'inserted':
      status.set(`Inserted ${msg.name}`, 'ok');
      break;
    case 'export-progress':
      status.set(`Exporting ${msg.done + 1} of ${msg.total}…`);
      break;
    case 'exported':
      session?.add(msg.file);
      break;
    case 'export-done': {
      try {
        const count = session ? await session.finish() : 0;
        const errs = msg.errors.length ? `\n${msg.errors.join('\n')}` : '';
        status.set(
          `Exported ${count} file${count === 1 ? '' : 's'}.${errs}`,
          msg.errors.length ? 'err' : 'ok',
        );
      } catch (e) {
        status.set((e as Error).message, 'err');
      }
      session = null;
      busy = false;
      refreshButton();
      break;
    }
    case 'error':
      busy = false;
      status.set(msg.message, 'err');
      refreshButton();
      break;
  }
});

renderInsert();
renderExport();
