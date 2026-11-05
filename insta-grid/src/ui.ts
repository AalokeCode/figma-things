import { zipSync } from 'fflate';
import { $, Status, download, esc, onPluginMessage, post, wireShell } from '../../shared/ui-kit';
import {
  GRID,
  canvasSize,
  type CodeToUi,
  type Method,
  type SelectionState,
  type UiToCode,
} from './types';

wireShell();
const send = (m: UiToCode) => post(m);
const status = new Status($('status'));
const goBtn = $<HTMLButtonElement>('go');
const colsSel = $<HTMLSelectElement>('cols');
const rowsSel = $<HTMLSelectElement>('rows');
const methodSel = $<HTMLSelectElement>('method');

colsSel.innerHTML = [1, 2, 3, 4, 5]
  .map((n) => `<option value="${n}"${n === 3 ? ' selected' : ''}>${n}</option>`)
  .join('');

let state: SelectionState = { kind: 'none', reason: 'Select a comp to split' };
let busy = false;

const cols = () => parseInt(colsSel.value, 10);
const rows = () => parseInt(rowsSel.value, 10); // 0 = auto

function fillRows(auto: number): void {
  const keep = rowsSel.value || '0';
  rowsSel.innerHTML =
    `<option value="0">Auto (${auto})</option>` +
    [1, 2, 3, 4].map((n) => `<option value="${n}">${n}</option>`).join('');
  rowsSel.value = keep;
}

function render(): void {
  const s = state;
  $('gridSection').classList.toggle('hidden', s.kind !== 'comp');
  $('selMeta').textContent = '';
  goBtn.disabled = busy;

  if (s.kind === 'none') {
    $('selText').textContent = s.reason;
    goBtn.textContent = 'Select a comp';
    goBtn.disabled = true;
  }
  if (s.kind === 'comp') {
    $('selText').innerHTML = `<b>${esc(s.name)}</b>`;
    $('selMeta').textContent = `${Math.round(s.width)} × ${Math.round(s.height)}`;
    fillRows(s.autoRows);
    const r = rows() || s.autoRows;
    const c = canvasSize(cols(), r);
    const method = methodSel.value as Method;
    const willAi = method === 'ai' || (method === 'auto' && !s.extendable);
    $('canvasHint').innerHTML =
      `Canvas <b>${c.w} × ${c.h}</b> · ${cols() * r} posts<br>` +
      (s.extendable ? 'Edges extendable' : esc(s.why)) +
      (willAi ? ' → AI expand' : ' → extend layers');
    goBtn.textContent = busy ? 'Working…' : 'Prepare canvas';
  }
  if (s.kind === 'canvas') {
    $('selText').innerHTML = `<b>${esc(s.name)}</b>`;
    $('selMeta').textContent = `${s.cols}×${s.rows}`;
    goBtn.textContent = `Slice into ${s.cols * s.rows} posts`;
  }
  if (s.kind === 'posts') {
    $('selText').textContent = `Each post ${GRID.postW} × ${GRID.postH}`;
    $('selMeta').textContent = `${s.count} posts`;
    goBtn.textContent = busy ? 'Exporting…' : `Export ${s.count} JPG${s.count === 1 ? '' : 's'}`;
  }
}

const inspect = () => send({ type: 'inspect', cols: cols(), rows: rows() });
colsSel.addEventListener('change', () => {
  rowsSel.value = '0';
  inspect();
});
rowsSel.addEventListener('change', inspect);
methodSel.addEventListener('change', render);

goBtn.addEventListener('click', () => {
  busy = true;
  status.clear();
  render();
  if (state.kind === 'comp') {
    send({ type: 'prepare', cols: cols(), rows: rows(), method: methodSel.value as Method });
  } else if (state.kind === 'canvas') send({ type: 'slice' });
  else if (state.kind === 'posts') send({ type: 'export' });
});

onPluginMessage<CodeToUi>((msg) => {
  if (msg.type === 'selection') {
    state = msg.state;
    render();
  }
  if (msg.type === 'done') {
    busy = false;
    status.set(msg.message, 'ok');
    render();
  }
  if (msg.type === 'exported') {
    busy = false;
    if (msg.files.length === 1) download(msg.files[0].bytes, msg.files[0].name, 'image/jpeg');
    else {
      const files: Record<string, Uint8Array> = {};
      msg.files.forEach((f) => (files[f.name] = f.bytes));
      download(zipSync(files, { level: 0 }), 'Instagram grid.zip', 'application/zip');
    }
    status.set(`Exported ${msg.files.length} posts.`, 'ok');
    render();
  }
  if (msg.type === 'error') {
    busy = false;
    status.set(msg.message, 'err');
    render();
  }
});

render();
