/// <reference types="@figma/plugin-typings" />
import {
  MM_PER_IN,
  type CodeToUi,
  type ExportRequest,
  type FrameInfo,
  type InsertRequest,
  type PrintMeta,
  type UiToCode,
} from './types';

const META_KEY = 'print';
type Exportable = FrameNode | ComponentNode | InstanceNode | GroupNode;

function send(msg: CodeToUi): void {
  figma.ui.postMessage(msg);
}

class PrintMetaStore {
  static read(node: BaseNode): PrintMeta | null {
    const raw = node.getPluginData(META_KEY);
    if (!raw) return null;
    try {
      const meta = JSON.parse(raw) as PrintMeta;
      return meta.dpi > 0 ? meta : null;
    } catch {
      return null;
    }
  }

  static write(node: BaseNode, meta: PrintMeta): void {
    node.setPluginData(META_KEY, JSON.stringify(meta));
  }
}

class SelectionReader {
  static isExportable(node: SceneNode): node is Exportable {
    return ['FRAME', 'COMPONENT', 'INSTANCE', 'GROUP'].includes(node.type);
  }

  static frames(): Exportable[] {
    return figma.currentPage.selection.filter(SelectionReader.isExportable);
  }

  static info(): FrameInfo[] {
    return SelectionReader.frames().map((n) => ({
      id: n.id,
      name: n.name,
      width: n.width,
      height: n.height,
      meta: PrintMetaStore.read(n),
    }));
  }
}

class FrameInserter {
  static insert(req: InsertRequest): FrameNode {
    const px = (mm: number) => Math.max(1, Math.round((mm / MM_PER_IN) * req.dpi));
    const frame = figma.createFrame();
    frame.resize(px(req.widthMm), px(req.heightMm));
    frame.name = req.name;
    frame.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
    const { x, y } = figma.viewport.center;
    frame.x = Math.round(x - frame.width / 2);
    frame.y = Math.round(y - frame.height / 2);
    PrintMetaStore.write(frame, { widthMm: req.widthMm, heightMm: req.heightMm, dpi: req.dpi });
    figma.currentPage.appendChild(frame);
    figma.currentPage.selection = [frame];
    figma.viewport.scrollAndZoomIntoView([frame]);
    return frame;
  }
}

class FrameExporter {
  /** Physical width in inches: pixel width ÷ the frame's DPI. */
  private static widthIn(node: Exportable, req: ExportRequest): number {
    const meta = PrintMetaStore.read(node);
    return node.width / (meta?.dpi ?? req.fallbackDpi);
  }

  /** Vector PDF at true physical size: a temporary clone is rescaled so 1px = 1pt. */
  private static async vectorPdf(node: Exportable, widthIn: number): Promise<Uint8Array> {
    const clone = node.clone();
    try {
      figma.currentPage.appendChild(clone);
      clone.x = node.absoluteTransform[0][2];
      clone.y = node.absoluteTransform[1][2] + node.height + 1000;
      clone.rescale((widthIn * 72) / node.width);
      return await clone.exportAsync({ format: 'PDF' });
    } finally {
      clone.remove();
    }
  }

  static async run(req: ExportRequest): Promise<void> {
    const errors: string[] = [];
    const found = await Promise.all(req.ids.map((id) => figma.getNodeByIdAsync(id)));
    const nodes = found.filter(
      (n): n is Exportable => !!n && SelectionReader.isExportable(n as SceneNode),
    );

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      send({ type: 'export-progress', done: i, total: nodes.length, current: node.name });
      try {
        const widthIn = FrameExporter.widthIn(node, req);
        const heightIn = (widthIn * node.height) / node.width;
        const base = { name: node.name, widthIn, heightIn };

        if (req.mode === 'rgb' && req.format === 'pdf') {
          send({
            type: 'exported',
            file: { ...base, kind: 'pdf', bytes: await FrameExporter.vectorPdf(node, widthIn) },
          });
          continue;
        }
        const scale = (widthIn * req.outDpi) / node.width;
        const kind = req.mode === 'rgb' && req.format === 'jpg' ? 'jpg' : 'png';
        const bytes = await node.exportAsync({
          format: kind === 'jpg' ? 'JPG' : 'PNG',
          constraint: { type: 'SCALE', value: scale },
        });
        send({ type: 'exported', file: { ...base, kind, bytes } });
      } catch (e) {
        errors.push(`${node.name}: ${(e as Error).message}`);
      }
    }
    send({ type: 'export-done', errors });
  }
}

figma.showUI(__html__, { width: 280, height: 392 });

const pushSelection = () => send({ type: 'selection', frames: SelectionReader.info() });

figma.ui.onmessage = async (msg: UiToCode) => {
  try {
    if (msg.type === 'close') return figma.closePlugin();
    if (msg.type === 'insert') {
      const frame = FrameInserter.insert(msg);
      send({ type: 'inserted', name: frame.name });
    }
    if (msg.type === 'export') await FrameExporter.run(msg);
  } catch (e) {
    send({ type: 'error', message: (e as Error).message });
  }
};

figma.on('selectionchange', pushSelection);
pushSelection();
