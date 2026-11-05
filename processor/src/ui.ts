import { $, Status, esc, icon, onPluginMessage, post, wireShell } from '../../shared/ui-kit';
import { readDataFile, type Table, type Workbook } from './lib/data';
import {
  normalizeKey,
  type CodeToUi,
  type TemplateInfo,
  type TextLayerInfo,
  type UiToCode,
} from './types';

wireShell();
const send = (m: UiToCode) => post(m);
const status = new Status($('status'));

/* ---------- State ---------- */
let template: TemplateInfo | null = null;
let templateReason = 'Select a frame on the canvas';
let layers: TextLayerInfo[] = [];
let workbook: Workbook | null = null;
let sheetIndex = 0;
let busy = false;
/** layer key → column index; -1 = keep text / use {{tags}}. Reset when the template changes. */
let bindings: Record<string, number> = {};

const table = (): Table | null => workbook?.sheets[sheetIndex]?.table ?? null;
const headers = () => table()?.headers ?? [];

/* ---------- Mapping ---------- */
function headerIndexFor(name: string): number {
  const key = normalizeKey(name);
  return key ? headers().findIndex((h) => normalizeKey(h) === key) : -1;
}

function autoBind(): void {
  const next: Record<string, number> = {};
  for (const l of layers) {
    const kept = bindings[l.key];
    next[l.key] =
      kept !== undefined && kept < headers().length
        ? kept
        : l.tokens.length
          ? -1
          : headerIndexFor(l.name);
  }
  bindings = next;
}

function tokenMap(): Record<string, number> {
  const map: Record<string, number> = {};
  for (const l of layers) {
    if (bindings[l.key] >= 0) continue;
    for (const t of l.tokens) {
      const i = headerIndexFor(t);
      if (i >= 0) map[normalizeKey(t)] = i;
    }
  }
  return map;
}

function wholeBindings(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bindings)) if (v >= 0) out[k] = v;
  return out;
}

function mappedCount(): number {
  const tokens = tokenMap();
  return layers.filter(
    (l) => bindings[l.key] >= 0 || l.tokens.some((t) => normalizeKey(t) in tokens),
  ).length;
}

/* ---------- Render ---------- */
const options = (selected: number, first: string) =>
  [`<option value="-1">${esc(first)}</option>`]
    .concat(
      headers().map(
        (h, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${esc(h)}</option>`,
      ),
    )
    .join('');

const perRow = $<HTMLSelectElement>('perRow');
perRow.innerHTML = [1, 2, 3, 4, 5, 6, 8, 10]
  .map((n) => `<option value="${n}"${n === 5 ? ' selected' : ''}>${n} per row</option>`)
  .join('');

function render(): void {
  $('template').innerHTML = template
    ? `<b>${esc(template.name)}</b> · ${layers.length} text layer${layers.length === 1 ? '' : 's'}`
    : esc(templateReason);

  const t = table();
  $('fileName').textContent = workbook ? workbook.fileName : 'CSV, TSV or XLSX';
  $('dataMeta').textContent = t ? `${t.rows.length} rows` : '';
  $('sheetRow').classList.toggle('hidden', !workbook || workbook.sheets.length < 2);
  if (workbook) {
    $('sheet').innerHTML = workbook.sheets
      .map(
        (s, i) =>
          `<option value="${i}"${i === sheetIndex ? ' selected' : ''}>${esc(s.name)}</option>`,
      )
      .join('');
  }

  const ready = !!template && !!t;
  $('layersSection').classList.toggle('hidden', !ready);
  $('layoutSection').classList.toggle('hidden', !ready);
  if (ready) {
    const tokens = tokenMap();
    $('mappedMeta').textContent = `${mappedCount()}/${layers.length}`;
    $('mapping').innerHTML = layers.length
      ? layers
          .map((l) => {
            const b = bindings[l.key];
            const tagNote =
              b < 0 && l.tokens.length
                ? l.tokens.map((x) => (normalizeKey(x) in tokens ? x : `${x} ✕`)).join(', ')
                : l.preview;
            return `<div class="layer">${icon('type')}
              <span class="name">${esc(l.name)}<small>${esc(tagNote)}</small></span>
              <select class="select" data-key="${esc(l.key)}">${options(b, l.tokens.length ? '{{tags}}' : '—')}</select>
            </div>`;
          })
          .join('')
      : '<div class="hint">No text layers in this frame</div>';
    const nameSel = $<HTMLSelectElement>('nameCol');
    const keep = nameSel.value;
    nameSel.innerHTML = options(-1, 'Row number');
    nameSel.value = keep && Number(keep) < headers().length ? keep : '-1';
  }

  const go = $<HTMLButtonElement>('go');
  const n = t?.rows.length ?? 0;
  go.textContent = busy
    ? 'Generating…'
    : ready
      ? `Generate ${n} cop${n === 1 ? 'y' : 'ies'}`
      : 'Generate';
  go.disabled = busy || !ready || !n || mappedCount() === 0;
}

/* ---------- File ---------- */
async function loadFile(file: File): Promise<void> {
  try {
    const wb = await readDataFile(file);
    const first = wb.sheets.findIndex((s) => s.table.rows.length > 0);
    if (first < 0) throw new Error('No rows found below the header row.');
    workbook = wb;
    sheetIndex = first;
    bindings = {};
    autoBind();
    status.clear();
  } catch (e) {
    status.set((e as Error).message, 'err');
  }
  render();
}

const fileInput = $<HTMLInputElement>('file');
$('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) void loadFile(f);
  fileInput.value = '';
});
const app = $('app');
app.addEventListener('dragover', (e) => {
  e.preventDefault();
  app.classList.add('over');
});
app.addEventListener('dragleave', () => app.classList.remove('over'));
app.addEventListener('drop', (e) => {
  e.preventDefault();
  app.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) void loadFile(f);
});

$('sheet').addEventListener('change', (e) => {
  sheetIndex = Number((e.target as HTMLSelectElement).value);
  bindings = {};
  autoBind();
  render();
});
$('mapping').addEventListener('change', (e) => {
  const sel = e.target as HTMLSelectElement;
  if (!sel.dataset.key) return;
  bindings[sel.dataset.key] = Number(sel.value);
  render();
});

/* ---------- Generate ---------- */
$('go').addEventListener('click', () => {
  const t = table();
  if (!t || !template) return;
  busy = true;
  status.set('Generating…');
  render();
  send({
    type: 'generate',
    templateId: template.id,
    rows: t.rows,
    bindings: wholeBindings(),
    tokens: tokenMap(),
    columns: parseInt(perRow.value, 10) || 5,
    gap: Math.max(0, parseInt($<HTMLInputElement>('gap').value, 10) || 0),
    nameColumn: Number($<HTMLSelectElement>('nameCol').value),
    hideEmpty: false,
    firstRow: 1,
  });
});

onPluginMessage<CodeToUi>((msg) => {
  switch (msg.type) {
    case 'template': {
      if (busy) return;
      if (msg.template?.id !== template?.id) bindings = {};
      template = msg.template;
      templateReason = msg.reason;
      layers = msg.layers;
      autoBind();
      render();
      break;
    }
    case 'progress':
      status.set(`Generated ${msg.done} of ${msg.total}…`);
      break;
    case 'generated':
      busy = false;
      status.set(
        `Created ${msg.count} cop${msg.count === 1 ? 'y' : 'ies'}.` +
          (msg.warnings.length ? `\n${msg.warnings.join('\n')}` : ''),
        msg.warnings.length ? 'err' : 'ok',
      );
      render();
      break;
    case 'error':
      busy = false;
      status.set(msg.message, 'err');
      render();
      break;
  }
});

render();
