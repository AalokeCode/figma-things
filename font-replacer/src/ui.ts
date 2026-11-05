import { $, Status, esc, onPluginMessage, post, wireShell } from '../../shared/ui-kit';

interface StateMsg {
  type: 'state';
  families: string[];
  usedFamilies: string[];
  scope: 'selection' | 'page';
  textCount: number;
}
interface DoneMsg {
  type: 'done';
  report: {
    nodes: number;
    segments: number;
    skipped: number;
    styleFallbacks: Record<string, string>;
    skippedReasons: string[];
  };
}
type Incoming = StateMsg | DoneMsg | { type: 'error'; message: string };

wireShell();

let state: StateMsg | null = null;
const status = new Status($('out'));
const from = $<HTMLSelectElement>('from');
const toInput = $<HTMLInputElement>('to');
const goBtn = $<HTMLButtonElement>('go');

onPluginMessage<Incoming>((msg) => {
  if (msg.type === 'state') {
    state = msg;
    $('scope').textContent =
      `${msg.textCount} layers in ${msg.scope === 'selection' ? 'selection' : 'page'}`;
    const keep = from.value;
    from.innerHTML =
      '<option value="">All families</option>' +
      msg.usedFamilies.map((f) => `<option>${esc(f)}</option>`).join('');
    from.value = msg.usedFamilies.includes(keep) ? keep : '';
    $('families').innerHTML = msg.families.map((f) => `<option value="${esc(f)}">`).join('');
    if (!toInput.value && msg.families.includes('Uncut Sans')) toInput.value = 'Uncut Sans';
    goBtn.disabled = false;
  }
  if (msg.type === 'done') {
    const { nodes, segments, skipped, styleFallbacks, skippedReasons } = msg.report;
    const fb = Object.entries(styleFallbacks).map(([a, b]) => `${a} → ${b}`);
    status.set(
      `Updated ${nodes} layers (${segments} runs).` +
        (skipped ? `\nSkipped ${skipped}: ${skippedReasons.join('; ')}` : '') +
        (fb.length ? `\nFallbacks: ${fb.join(', ')}` : ''),
      skipped ? 'err' : 'ok',
    );
  }
  if (msg.type === 'error') status.set(msg.message, 'err');
});

goBtn.addEventListener('click', () => {
  const targetFamily = toInput.value.trim();
  if (!state || !targetFamily) return;
  if (!state.families.includes(targetFamily)) {
    status.set(`"${targetFamily}" isn't installed.`, 'err');
    return;
  }
  goBtn.disabled = true;
  status.set('Replacing…');
  post({ type: 'replace', targetFamily, sourceFamily: from.value || null, scope: state.scope });
});
