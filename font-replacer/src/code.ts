/// <reference types="@figma/plugin-typings" />

type Scope = 'selection' | 'page';

interface ReplaceRequest {
  type: 'replace';
  targetFamily: string;
  sourceFamily: string | null; // null = replace every family
  scope: Scope;
}

interface ReplaceReport {
  nodes: number;
  segments: number;
  skipped: number;
  styleFallbacks: Record<string, string>;
  skippedReasons: string[];
}

type UiMessage = ReplaceRequest | { type: 'refresh' } | { type: 'close' };

const WEIGHTS: Array<[RegExp, number]> = [
  [/thin|hairline/i, 100],
  [/extra\s*light|ultra\s*light/i, 200],
  [/light/i, 300],
  [/regular|normal|book|roman/i, 400],
  [/medium/i, 500],
  [/semi\s*bold|demi\s*bold/i, 600],
  [/extra\s*bold|ultra\s*bold/i, 800],
  [/bold/i, 700],
  [/black|heavy/i, 900],
];

class StyleResolver {
  /** Numeric styles ("700", "800 Italic", "W800", "1000") win over keywords; unknown names count as 400. */
  static weightOf(style: string): number {
    const numeric = style.match(/(?:^|\D)(\d{1,4})(?!\d)/);
    if (numeric && Number(numeric[1]) >= 1 && Number(numeric[1]) <= 1000) return Number(numeric[1]);
    for (const [pattern, weight] of WEIGHTS) if (pattern.test(style)) return weight;
    return 400;
  }

  static isItalic(style: string): boolean {
    return /italic|oblique/i.test(style);
  }

  /**
   * Picks the closest style in the target family: exact name, else same italic-ness + nearest weight
   * ("Bold" → "700", or "800" when 700 is missing). Ties go heavier for bold weights, lighter otherwise.
   */
  static resolve(sourceStyle: string, available: string[]): string {
    const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase();
    const exact = available.find((s) => normalize(s) === normalize(sourceStyle));
    if (exact) return exact;

    const wantItalic = StyleResolver.isItalic(sourceStyle);
    const wantWeight = StyleResolver.weightOf(sourceStyle);
    const pool = available.filter((s) => StyleResolver.isItalic(s) === wantItalic);
    const candidates = pool.length ? pool : available;
    const preferHeavier = wantWeight >= 600;

    return candidates.reduce((best, s) => {
      const w = StyleResolver.weightOf(s);
      const b = StyleResolver.weightOf(best);
      const dw = Math.abs(w - wantWeight);
      const db = Math.abs(b - wantWeight);
      if (dw !== db) return dw < db ? s : best;
      return (preferHeavier ? w > b : w < b) ? s : best;
    });
  }
}

class FontCatalog {
  private families = new Map<string, string[]>();

  async load(): Promise<void> {
    const fonts = await figma.listAvailableFontsAsync();
    this.families.clear();
    for (const { fontName } of fonts) {
      const styles = this.families.get(fontName.family) ?? [];
      styles.push(fontName.style);
      this.families.set(fontName.family, styles);
    }
  }

  familyNames(): string[] {
    return [...this.families.keys()].sort((a, b) => a.localeCompare(b));
  }

  stylesOf(family: string): string[] {
    return this.families.get(family) ?? [];
  }
}

class TextCollector {
  static collect(scope: Scope): TextNode[] {
    const roots: readonly SceneNode[] =
      scope === 'selection' ? figma.currentPage.selection : figma.currentPage.children;
    const result: TextNode[] = [];
    for (const root of roots) {
      if (root.type === 'TEXT') result.push(root);
      if ('findAllWithCriteria' in root) {
        result.push(...root.findAllWithCriteria({ types: ['TEXT'] }));
      }
    }
    return result;
  }

  static familiesIn(nodes: TextNode[]): string[] {
    const set = new Set<string>();
    for (const node of nodes) {
      for (const seg of node.getStyledTextSegments(['fontName'])) set.add(seg.fontName.family);
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }
}

class FontReplacer {
  private loaded = new Set<string>();

  constructor(private readonly catalog: FontCatalog) {}

  private failed = new Set<string>();

  private async ensureLoaded(font: FontName): Promise<void> {
    const key = `${font.family}::${font.style}`;
    if (this.loaded.has(key)) return;
    await figma.loadFontAsync(font);
    this.loaded.add(key);
  }

  /** Loads every font already in the node (best effort): Figma refuses edits to a mixed layer while any run's font is unloaded. */
  private async preloadNode(node: TextNode): Promise<void> {
    for (const font of node.getRangeAllFontNames(0, node.characters.length)) {
      const key = `${font.family}::${font.style}`;
      if (this.loaded.has(key) || this.failed.has(key)) continue;
      try {
        await this.ensureLoaded(font);
      } catch {
        this.failed.add(key); // missing locally; the target font may still apply over it
      }
    }
  }

  async run(req: ReplaceRequest): Promise<ReplaceReport> {
    const targetStyles = this.catalog.stylesOf(req.targetFamily);
    if (!targetStyles.length) throw new Error(`"${req.targetFamily}" is not installed.`);

    const report: ReplaceReport = {
      nodes: 0,
      segments: 0,
      skipped: 0,
      styleFallbacks: {},
      skippedReasons: [],
    };
    const nodes = TextCollector.collect(req.scope);

    for (const node of nodes) {
      if (!node.characters.length) continue;
      const segments = node
        .getStyledTextSegments(['fontName'])
        .filter(
          ({ fontName: { family } }) =>
            family !== req.targetFamily && (!req.sourceFamily || family === req.sourceFamily),
        );
      if (!segments.length) continue;

      await this.preloadNode(node);
      let touched = false;
      for (const seg of segments) {
        const { style } = seg.fontName;
        const targetStyle = StyleResolver.resolve(style, targetStyles);
        if (targetStyle.toLowerCase() !== style.toLowerCase()) {
          report.styleFallbacks[style] = targetStyle;
        }
        const target: FontName = { family: req.targetFamily, style: targetStyle };
        try {
          await this.ensureLoaded(target);
          node.setRangeFontName(seg.start, seg.end, target);
          report.segments++;
          touched = true;
        } catch (e) {
          report.skipped++;
          if (report.skippedReasons.length < 5)
            report.skippedReasons.push(`"${node.name}": ${(e as Error).message}`);
        }
      }
      if (touched) report.nodes++;
    }
    return report;
  }
}

const catalog = new FontCatalog();
const replacer = new FontReplacer(catalog);

async function sendState(): Promise<void> {
  const scope: Scope = figma.currentPage.selection.length ? 'selection' : 'page';
  const nodes = TextCollector.collect(scope);
  figma.ui.postMessage({
    type: 'state',
    families: catalog.familyNames(),
    usedFamilies: TextCollector.familiesIn(nodes),
    scope,
    textCount: nodes.length,
  });
}

figma.showUI(__html__, { width: 280, height: 228 });

figma.ui.onmessage = async (msg: UiMessage) => {
  if (msg.type === 'close') return figma.closePlugin();
  if (msg.type === 'refresh') return sendState();
  if (msg.type === 'replace') {
    try {
      const report = await replacer.run(msg);
      figma.ui.postMessage({ type: 'done', report });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: (e as Error).message });
    }
    await sendState();
  }
};

figma.on('selectionchange', () => void sendState());

(async () => {
  await catalog.load();
  await sendState();
})();
