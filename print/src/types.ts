export type Unit = 'mm' | 'cm' | 'in';
export type ColorMode = 'rgb' | 'cmyk';
export type ExportFormat = 'png' | 'jpg' | 'pdf' | 'tiff';

/** Stored on frames created by the plugin (pluginData key `print`). */
export interface PrintMeta {
  widthMm: number;
  heightMm: number;
  dpi: number;
}

export interface FrameInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  meta: PrintMeta | null;
}

export interface InsertRequest {
  type: 'insert';
  name: string;
  widthMm: number;
  heightMm: number;
  dpi: number;
}

export interface ExportRequest {
  type: 'export';
  ids: string[];
  /** DPI assumed for frames the plugin didn't create. */
  fallbackDpi: number;
  outDpi: number;
  mode: ColorMode;
  format: ExportFormat;
}

export type UiToCode = InsertRequest | ExportRequest | { type: 'close' };

export interface ExportedFile {
  name: string;
  /** PNG for raster/CMYK work, PDF for vector RGB. */
  bytes: Uint8Array;
  kind: 'png' | 'jpg' | 'pdf';
  widthIn: number;
  heightIn: number;
}

export type CodeToUi =
  | { type: 'selection'; frames: FrameInfo[] }
  | { type: 'inserted'; name: string }
  | { type: 'export-progress'; done: number; total: number; current: string }
  | { type: 'exported'; file: ExportedFile }
  | { type: 'export-done'; errors: string[] }
  | { type: 'error'; message: string };

export const MM_PER_IN = 25.4;
