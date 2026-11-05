/** Instagram profile-grid geometry (px). A post is 1148×1440; the grid shows its 1080×1350 window. */
export const GRID = {
  tileW: 1080,
  tileH: 1350,
  side: 34,
  bottom: 90,
  postW: 1148,
  postH: 1440,
} as const;

export type Method = 'auto' | 'extend' | 'ai';

export type SelectionState =
  | { kind: 'none'; reason: string }
  | {
      kind: 'comp';
      name: string;
      width: number;
      height: number;
      autoRows: number;
      extendable: boolean;
      why: string;
    }
  | { kind: 'canvas'; name: string; cols: number; rows: number }
  | { kind: 'posts'; count: number };

export interface PrepareRequest {
  type: 'prepare';
  cols: number;
  /** 0 = auto */
  rows: number;
  method: Method;
}

export type UiToCode =
  | PrepareRequest
  | { type: 'inspect'; cols: number; rows: number }
  | { type: 'slice' }
  | { type: 'export' }
  | { type: 'close' };

export type CodeToUi =
  | { type: 'selection'; state: SelectionState }
  | { type: 'done'; message: string }
  | { type: 'exported'; files: Array<{ name: string; bytes: Uint8Array }> }
  | { type: 'error'; message: string };

/** Canvas = every tile's grid window plus side and bottom bleed. */
export function canvasSize(cols: number, rows: number): { w: number; h: number } {
  return { w: cols * GRID.tileW + GRID.side * 2, h: rows * GRID.tileH + GRID.bottom };
}
