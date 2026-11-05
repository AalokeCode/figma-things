export interface TextLayerInfo {
  /** Child-index path from the template root, e.g. "0/2/1". Stable across clones. */
  key: string;
  name: string;
  preview: string;
  /** `{{token}}` names found in the text, in order (deduped). */
  tokens: string[];
}

export interface TemplateInfo {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
}

export interface GenerateRequest {
  type: 'generate';
  templateId: string;
  rows: string[][];
  /** Whole-text bindings: layer key → column index. */
  bindings: Record<string, number>;
  /** Token bindings: normalised token → column index. */
  tokens: Record<string, number>;
  columns: number;
  gap: number;
  /** Column used to name each copy; -1 = "<template> – N". */
  nameColumn: number;
  hideEmpty: boolean;
  /** 1-based row number of rows[0], for naming. */
  firstRow: number;
}

export type UiToCode = GenerateRequest | { type: 'close' };

export type CodeToUi =
  | { type: 'template'; template: TemplateInfo | null; layers: TextLayerInfo[]; reason: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'generated'; count: number; warnings: string[] }
  | { type: 'error'; message: string };

const TOKEN_SOURCE = '\\{\\{\\s*([^{}]+?)\\s*\\}\\}';

export interface TokenMatch {
  name: string;
  index: number;
  length: number;
}

/** All `{{ token }}` occurrences in reading order. */
export function findTokens(text: string): TokenMatch[] {
  const re = new RegExp(TOKEN_SOURCE, 'g');
  const out: TokenMatch[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out.push({ name: m[1], index: m.index, length: m[0].length });
  }
  return out;
}

/** Lowercase, alphanumerics only — used for auto-matching names to headers. */
export function normalizeKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
