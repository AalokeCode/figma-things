/// <reference types="@figma/plugin-typings" />
import {
  findTokens,
  normalizeKey,
  type CodeToUi,
  type GenerateRequest,
  type TemplateInfo,
  type TextLayerInfo,
  type UiToCode,
} from './types';

type Template = FrameNode | ComponentNode | InstanceNode | GroupNode;
const TEMPLATE_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP'];

function send(msg: CodeToUi): void {
  figma.ui.postMessage(msg);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

class TemplateReader {
  static current(): { template: Template | null; reason: string } {
    const sel = figma.currentPage.selection;
    if (sel.length !== 1) {
      return {
        template: null,
        reason: sel.length ? 'Select just one frame' : 'Select a frame to use as template',
      };
    }
    const node = sel[0];
    if (!TEMPLATE_TYPES.includes(node.type))
      return { template: null, reason: 'Selection must be a frame, component, instance or group' };
    return { template: node as Template, reason: '' };
  }

  static tokensOf(text: string): string[] {
    const out: string[] = [];
    for (const m of findTokens(text)) if (!out.includes(m.name)) out.push(m.name);
    return out;
  }

  /** Depth-first list of text layers with their child-index path. */
  static textLayers(root: Template): TextLayerInfo[] {
    const out: TextLayerInfo[] = [];
    const walk = (node: SceneNode, path: number[]) => {
      if (node.type === 'TEXT') {
        const text = node.characters;
        out.push({
          key: path.join('/'),
          name: node.name,
          preview: text.length > 60 ? `${text.slice(0, 60)}…` : text,
          tokens: TemplateReader.tokensOf(text),
        });
        return;
      }
      if ('children' in node) node.children.forEach((c, i) => walk(c, [...path, i]));
    };
    root.children.forEach((c, i) => walk(c, [i]));
    return out;
  }

  static info(t: Template): TemplateInfo {
    return { id: t.id, name: t.name, type: t.type, width: t.width, height: t.height };
  }
}

class FontLoader {
  private loaded = new Set<string>();

  async forNode(node: TextNode): Promise<void> {
    const fonts =
      node.characters.length > 0
        ? node.getRangeAllFontNames(0, node.characters.length)
        : [node.fontName as FontName];
    for (const f of fonts) {
      if (typeof f !== 'object') continue;
      const key = `${f.family}::${f.style}`;
      if (this.loaded.has(key)) continue;
      await figma.loadFontAsync(f);
      this.loaded.add(key);
    }
  }
}

class TextWriter {
  /** Replaces {{tokens}} in place, preserving each token's own styling. Unknown tokens are left alone. */
  static replaceTokens(node: TextNode, values: Record<string, string | undefined>): void {
    const matches = findTokens(node.characters).reverse();
    for (const m of matches) {
      const value = values[normalizeKey(m.name)];
      if (value === undefined) continue;
      const start = m.index;
      const end = start + m.length;
      if (value.length) {
        node.insertCharacters(start, value, 'AFTER');
        node.deleteCharacters(start + value.length, end + value.length);
      } else {
        node.deleteCharacters(start, end);
      }
    }
  }
}

class Generator {
  private fonts = new FontLoader();

  private static nodeAt(root: SceneNode, key: string): SceneNode | null {
    let node: SceneNode = root;
    for (const part of key.split('/')) {
      if (!('children' in node)) return null;
      const next: SceneNode | undefined = node.children[Number(part)];
      if (!next) return null;
      node = next;
    }
    return node;
  }

  private static copyOf(template: Template): SceneNode {
    if (template.type === 'COMPONENT') {
      const inst = template.createInstance();
      (template.parent ?? figma.currentPage).appendChild(inst);
      return inst;
    }
    return template.clone();
  }

  async run(req: GenerateRequest): Promise<void> {
    const node = await figma.getNodeByIdAsync(req.templateId);
    if (!node || !TEMPLATE_TYPES.includes(node.type))
      throw new Error('Template frame no longer exists.');
    const template = node as Template;
    const layers = TemplateReader.textLayers(template);
    const warnings = new Set<string>();
    const created: SceneNode[] = [];
    const cols = Math.max(1, Math.floor(req.columns));
    const startX = template.x + template.width + req.gap * 2;

    for (let i = 0; i < req.rows.length; i++) {
      const row = req.rows[i];
      const copy = Generator.copyOf(template);
      const col = i % cols;
      const line = Math.floor(i / cols);
      copy.x = startX + col * (template.width + req.gap);
      copy.y = template.y + line * (template.height + req.gap);
      const label = req.nameColumn >= 0 ? (row[req.nameColumn] ?? '').trim() : '';
      copy.name = label || `${template.name} – ${req.firstRow + i}`;

      const tokenValues: Record<string, string> = {};
      for (const [tok, c] of Object.entries(req.tokens)) tokenValues[tok] = row[c] ?? '';

      for (const layer of layers) {
        const bound = req.bindings[layer.key];
        const hasTokens = layer.tokens.some((t) => tokenValues[normalizeKey(t)] !== undefined);
        if (bound === undefined && !hasTokens) continue;
        const text = Generator.nodeAt(copy, layer.key);
        if (!text || text.type !== 'TEXT') continue;
        try {
          await this.fonts.forNode(text);
          if (bound !== undefined) text.characters = row[bound] ?? '';
          else TextWriter.replaceTokens(text, tokenValues);
          if (req.hideEmpty && text.characters.trim() === '') text.visible = false;
        } catch (e) {
          warnings.add(`${layer.name}: ${(e as Error).message}`);
        }
      }
      created.push(copy);
      if (i % 10 === 9) {
        send({ type: 'progress', done: i + 1, total: req.rows.length });
        await tick();
      }
    }

    figma.currentPage.selection = [template];
    if (created.length) figma.viewport.scrollAndZoomIntoView([template, ...created]);
    send({ type: 'generated', count: created.length, warnings: [...warnings].slice(0, 6) });
  }
}

figma.showUI(__html__, { width: 300, height: 480 });

function pushTemplate(): void {
  const { template, reason } = TemplateReader.current();
  send({
    type: 'template',
    template: template ? TemplateReader.info(template) : null,
    layers: template ? TemplateReader.textLayers(template) : [],
    reason,
  });
}

const generator = new Generator();
let busy = false;

figma.ui.onmessage = async (msg: UiToCode) => {
  if (msg.type === 'close') return figma.closePlugin();
  if (msg.type === 'generate') {
    busy = true;
    try {
      await generator.run(msg);
    } catch (e) {
      send({ type: 'error', message: (e as Error).message });
    } finally {
      busy = false;
      pushTemplate();
    }
  }
};

let refreshTimer = 0;
function scheduleRefresh(): void {
  if (busy) return;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(pushTemplate, 250);
}

/** Text edits inside the template change its layer list/tokens, so watch the current page. */
let watchedPage: PageNode | null = null;
function watchPage(): void {
  watchedPage?.off('nodechange', scheduleRefresh);
  watchedPage = figma.currentPage;
  watchedPage.on('nodechange', scheduleRefresh);
}

figma.on('selectionchange', scheduleRefresh);
figma.on('currentpagechange', () => {
  watchPage();
  scheduleRefresh();
});
watchPage();
pushTemplate();
