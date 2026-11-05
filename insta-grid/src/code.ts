/// <reference types="@figma/plugin-typings" />
import {
  GRID,
  canvasSize,
  type CodeToUi,
  type PrepareRequest,
  type SelectionState,
  type UiToCode,
} from './types';

type Comp = FrameNode | ComponentNode | InstanceNode | GroupNode;
const COMP_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP'];
const CANVAS_KEY = 'ig-canvas';
const POST_KEY = 'ig-post';
const MAX_IMAGE = 4096; // figma.createImage limit per side

function send(msg: CodeToUi): void {
  figma.ui.postMessage(msg);
}

/* ---------- Geometry ---------- */
interface Layout {
  scale: number;
  cols: number;
  rows: number;
  offY: number; // comp top inside the visible grid area (may be negative = cropped)
  ext: { left: number; right: number; top: number; bottom: number }; // canvas px to invent
}

function autoRows(comp: SceneNode, cols: number): number {
  const scaledH = comp.height * ((cols * GRID.tileW) / comp.width);
  return Math.max(1, Math.round(scaledH / GRID.tileH));
}

function layoutFor(comp: SceneNode, cols: number, rows: number): Layout {
  const scale = (cols * GRID.tileW) / comp.width;
  const scaledH = comp.height * scale;
  const visH = rows * GRID.tileH;
  const offY = (visH - scaledH) / 2;
  return {
    scale,
    cols,
    rows,
    offY,
    ext: {
      left: GRID.side,
      right: GRID.side,
      top: Math.max(0, offY),
      bottom: Math.max(0, visH - offY - scaledH) + GRID.bottom,
    },
  };
}

/* ---------- Extendability ---------- */
type Edge = 'left' | 'right' | 'top' | 'bottom';

interface EdgeHit {
  path: number[];
  edges: Edge[];
}

interface Analysis {
  extendable: boolean;
  why: string;
  stretch: EdgeHit[];
}

const isPlainFill = (fills: ReadonlyArray<Paint> | PluginAPI['mixed']) =>
  Array.isArray(fills) &&
  fills.every((p: Paint) => p.type === 'SOLID' || p.type.startsWith('GRADIENT'));

class Extender {
  /**
   * A comp is extendable when every layer reaching a bleed edge either already overflows far enough
   * (clipped content we can reveal) or is a plain solid/gradient shape we can stretch.
   */
  static analyze(comp: Comp, layout: Layout): Analysis {
    if (
      'fills' in comp &&
      Array.isArray(comp.fills) &&
      comp.fills.some((p: Paint) => p.type === 'IMAGE')
    ) {
      return { extendable: false, why: 'Background is an image', stretch: [] };
    }
    const box = comp.absoluteBoundingBox;
    if (!box) return { extendable: false, why: 'Comp has no bounds', stretch: [] };
    const need = {
      left: layout.ext.left / layout.scale,
      right: layout.ext.right / layout.scale,
      top: layout.ext.top / layout.scale,
      bottom: layout.ext.bottom / layout.scale,
    };
    const stretch: EdgeHit[] = [];
    let blocker = '';

    const walk = (node: SceneNode, path: number[]) => {
      if (blocker || !node.visible) return;
      const b = node.absoluteBoundingBox;
      if (b) {
        const edges: Edge[] = [];
        const reach = {
          left: box.x - b.x,
          right: b.x + b.width - (box.x + box.width),
          top: box.y - b.y,
          bottom: b.y + b.height - (box.y + box.height),
        };
        (Object.keys(reach) as Edge[]).forEach((e) => {
          // touches the edge (within 0.5px) but doesn't already overflow far enough
          if (need[e] > 0.01 && reach[e] > -0.5 && reach[e] < need[e]) edges.push(e);
        });
        if (edges.length) {
          if (Extender.stretchable(node)) {
            stretch.push({ path, edges });
            return;
          }
          const paints =
            'fills' in node && Array.isArray(node.fills) ? (node.fills as Paint[]) : [];
          const hasOwnPaint = paints.some((p) => p.visible !== false);
          if (!('children' in node) || hasOwnPaint) {
            blocker = `“${node.name}” is cut by the edge`;
            return;
          }
        }
      }
      if ('children' in node) node.children.forEach((c, i) => walk(c, [...path, i]));
    };
    comp.children.forEach((c, i) => walk(c, [i]));
    return blocker
      ? { extendable: false, why: blocker, stretch: [] }
      : { extendable: true, why: 'Edges can be extended', stretch };
  }

  private static stretchable(node: SceneNode): boolean {
    const shape =
      node.type === 'RECTANGLE' || (node.type === 'FRAME' && node.children.length === 0);
    if (!shape || !('fills' in node) || !isPlainFill(node.fills)) return false;
    if ('rotation' in node && Math.abs(node.rotation) > 0.01) return false;
    const parent = node.parent;
    const inAutoLayout =
      parent &&
      'layoutMode' in parent &&
      parent.layoutMode !== 'NONE' &&
      node.layoutPositioning !== 'ABSOLUTE';
    return !inAutoLayout;
  }

  static nodeAt(root: SceneNode, path: number[]): SceneNode | null {
    let node: SceneNode = root;
    for (const i of path) {
      if (!('children' in node)) return null;
      const next: SceneNode | undefined = node.children[i];
      if (!next) return null;
      node = next;
    }
    return node;
  }

  /** Editable copy: instances/components are detached so inner layers can move. */
  static editableCopy(comp: Comp): FrameNode | GroupNode {
    if (comp.type === 'COMPONENT') return comp.createInstance().detachInstance();
    const copy = comp.clone();
    return copy.type === 'INSTANCE' ? copy.detachInstance() : (copy as FrameNode | GroupNode);
  }

  static build(comp: Comp, layout: Layout, analysis: Analysis, canvas: FrameNode): void {
    const copy = Extender.editableCopy(comp);
    canvas.appendChild(copy);
    copy.rescale(layout.scale);
    copy.x = GRID.side;
    copy.y = layout.offY;
    if (copy.type === 'FRAME') {
      canvas.fills = JSON.parse(JSON.stringify(copy.fills)) as Paint[];
      copy.fills = [];
      copy.clipsContent = false;
    }
    const { ext } = layout;
    for (const hit of analysis.stretch) {
      const node = Extender.nodeAt(copy, hit.path);
      if (!node || !('resize' in node)) continue;
      let { x, y, width, height } = node;
      if (hit.edges.includes('left')) {
        x -= ext.left;
        width += ext.left;
      }
      if (hit.edges.includes('right')) width += ext.right;
      if (hit.edges.includes('top')) {
        y -= ext.top;
        height += ext.top;
      }
      if (hit.edges.includes('bottom')) height += ext.bottom;
      node.resize(width, height);
      node.x = x;
      node.y = y;
    }
  }
}

/* ---------- Canvas ---------- */
class CanvasBuilder {
  static frame(comp: Comp, layout: Layout): FrameNode {
    const { w, h } = canvasSize(layout.cols, layout.rows);
    const canvas = figma.createFrame();
    canvas.name = `IG grid canvas · ${layout.cols}×${layout.rows}`;
    canvas.resize(w, h);
    canvas.fills = [];
    canvas.clipsContent = true;
    const box = comp.absoluteBoundingBox;
    canvas.x = Math.round((box?.x ?? 0) + comp.width + 200);
    canvas.y = Math.round(box?.y ?? 0);
    canvas.setPluginData(CANVAS_KEY, JSON.stringify({ cols: layout.cols, rows: layout.rows }));
    figma.currentPage.appendChild(canvas);
    return canvas;
  }

  /** Flattens the comp to an opaque JPG inside the canvas so Figma's Expand image can fill the bleed. */
  static async aiPlaceholder(
    comp: Comp,
    layout: Layout,
    canvas: FrameNode,
  ): Promise<RectangleNode> {
    const exportScale = Math.min(layout.scale, MAX_IMAGE / comp.width, MAX_IMAGE / comp.height);
    const bytes = await comp.exportAsync({
      format: 'JPG',
      constraint: { type: 'SCALE', value: exportScale },
    });
    const image = figma.createImage(bytes);
    const rect = figma.createRectangle();
    rect.name = 'Expand me';
    rect.resize(layout.cols * GRID.tileW, comp.height * layout.scale);
    rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
    canvas.appendChild(rect);
    rect.x = GRID.side;
    rect.y = layout.offY;
    return rect;
  }
}

/* ---------- Slicing ---------- */
class Slicer {
  static canvasMeta(node: SceneNode): { cols: number; rows: number } | null {
    const raw = node.getPluginData(CANVAS_KEY);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        /* fall through to size match */
      }
    }
    if (node.type !== 'FRAME') return null;
    for (let cols = 1; cols <= 6; cols++) {
      for (let rows = 1; rows <= 6; rows++) {
        const s = canvasSize(cols, rows);
        if (Math.abs(node.width - s.w) < 1 && Math.abs(node.height - s.h) < 1)
          return { cols, rows };
      }
    }
    return null;
  }

  static run(canvas: FrameNode, cols: number, rows: number): FrameNode[] {
    const total = cols * rows;
    const posts: FrameNode[] = [];
    const guide = { r: 1, g: 0.2, b: 0.4, a: 0.12 };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const n = total - (r * cols + c); // Instagram shows newest first: bottom-right is posted first
        const post = figma.createFrame();
        post.name = `Post ${n}`;
        post.resize(GRID.postW, GRID.postH);
        post.clipsContent = true;
        post.fills = [];
        post.layoutGrids = [
          {
            pattern: 'COLUMNS',
            alignment: 'STRETCH',
            gutterSize: 0,
            count: 1,
            offset: GRID.side,
            visible: true,
            color: guide,
          },
          {
            pattern: 'ROWS',
            alignment: 'MIN',
            gutterSize: 0,
            count: 1,
            offset: 0,
            sectionSize: GRID.tileH,
            visible: true,
            color: guide,
          },
        ];
        post.x = canvas.x + c * (GRID.postW + 60);
        post.y = canvas.y + canvas.height + 200 + r * (GRID.postH + 60);
        post.setPluginData(POST_KEY, String(n));
        figma.currentPage.appendChild(post);

        const art = canvas.clone();
        art.setPluginData(CANVAS_KEY, '');
        art.name = 'Artwork';
        post.appendChild(art);
        art.x = -c * GRID.tileW;
        art.y = -r * GRID.tileH;
        posts.push(post);
      }
    }
    return posts;
  }
}

/* ---------- Selection ---------- */
let lastOpts = { cols: 3, rows: 0 };

function currentComp(): Comp | null {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1 || !COMP_TYPES.includes(sel[0].type)) return null;
  return sel[0] as Comp;
}

function inspect(): SelectionState {
  const sel = figma.currentPage.selection;
  if (!sel.length) return { kind: 'none', reason: 'Select a comp to split' };
  if (sel.every((n) => n.getPluginData(POST_KEY))) return { kind: 'posts', count: sel.length };
  const comp = currentComp();
  if (!comp) return { kind: 'none', reason: 'Select one frame or group' };
  const meta = Slicer.canvasMeta(comp);
  if (meta) return { kind: 'canvas', name: comp.name, ...meta };
  const rows = lastOpts.rows || autoRows(comp, lastOpts.cols);
  const a = Extender.analyze(comp, layoutFor(comp, lastOpts.cols, rows));
  return {
    kind: 'comp',
    name: comp.name,
    width: comp.width,
    height: comp.height,
    autoRows: autoRows(comp, lastOpts.cols),
    extendable: a.extendable,
    why: a.why,
  };
}

function pushSelection(): void {
  const state = inspect();
  figma.ui.resize(280, state.kind === 'comp' ? 336 : 196);
  send({ type: 'selection', state });
}

/* ---------- Actions ---------- */
async function prepare(req: PrepareRequest): Promise<void> {
  const comp = currentComp();
  if (!comp) throw new Error('Select one frame or group.');
  const rows = req.rows || autoRows(comp, req.cols);
  const layout = layoutFor(comp, req.cols, rows);
  const analysis = Extender.analyze(comp, layout);
  const useAi = req.method === 'ai' || (req.method === 'auto' && !analysis.extendable);
  const canvas = CanvasBuilder.frame(comp, layout);

  if (useAi) {
    const rect = await CanvasBuilder.aiPlaceholder(comp, layout, canvas);
    figma.currentPage.selection = [rect];
    figma.viewport.scrollAndZoomIntoView([canvas]);
    send({
      type: 'done',
      message:
        'Image placed. Use Figma’s Expand image on it and drag its edges to the canvas frame, then select the canvas and slice.',
    });
    return;
  }
  Extender.build(comp, layout, analysis, canvas);
  figma.currentPage.selection = [canvas];
  figma.viewport.scrollAndZoomIntoView([canvas]);
  send({ type: 'done', message: 'Canvas extended. Ready to slice.' });
}

function slice(): void {
  const node = figma.currentPage.selection[0];
  const meta = node ? Slicer.canvasMeta(node) : null;
  if (!node || node.type !== 'FRAME' || !meta) throw new Error('Select a prepared canvas.');
  const posts = Slicer.run(node, meta.cols, meta.rows);
  figma.currentPage.selection = posts;
  figma.viewport.scrollAndZoomIntoView([node, ...posts]);
  send({ type: 'done', message: `Created ${posts.length} posts. Upload Post 1 first.` });
}

async function exportPosts(): Promise<void> {
  const posts = figma.currentPage.selection
    .filter((n) => n.getPluginData(POST_KEY))
    .sort((a, b) => Number(a.getPluginData(POST_KEY)) - Number(b.getPluginData(POST_KEY)));
  if (!posts.length) throw new Error('Select posts to export.');
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  for (const p of posts) {
    files.push({ name: `${p.name}.jpg`, bytes: await p.exportAsync({ format: 'JPG' }) });
  }
  send({ type: 'exported', files });
}

figma.showUI(__html__, { width: 280, height: 300 });

figma.ui.onmessage = async (msg: UiToCode) => {
  try {
    if (msg.type === 'close') return figma.closePlugin();
    if (msg.type === 'inspect') {
      lastOpts = { cols: msg.cols, rows: msg.rows };
      return pushSelection();
    }
    if (msg.type === 'prepare') await prepare(msg);
    if (msg.type === 'slice') slice();
    if (msg.type === 'export') await exportPosts();
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
  pushSelection();
};

figma.on('selectionchange', pushSelection);
pushSelection();
