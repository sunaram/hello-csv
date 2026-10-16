export interface CsvParseOptions {
  delimiter?: string;
  hasHeader?: boolean;
}

export interface CsvParseResult {
  headers: string[];
  rows: string[][];
  totalRows: number;
  totalColumns: number;
  delimiter: string;
  fileName: string;
  fileSize?: number;
  errors?: string[];
  isStreamMode?: boolean;
  isIndexing?: boolean;
}

export interface SearchMatchItem {
  rowNumber: number; // 0-based data row index
  row: string[];
}

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'copyToClipboard'; text: string; format: 'markdown' | 'tsv' | 'cell' }
  | { type: 'requestReload'; delimiter?: string; hasHeader?: boolean }
  | { type: 'showInfo'; message: string }
  | { type: 'showError'; message: string }
  | { type: 'saveData'; headers: string[]; rows: string[][]; delimiter: string; hasHeader: boolean }
  | { type: 'saveDelta'; headers: string[]; modifiedRows: Record<number, string[]>; delimiter: string; hasHeader: boolean }
  | { type: 'setDirty'; isDirty: boolean }
  | { type: 'requestPage'; page: number; pageSize: number }
  | { type: 'startSearch'; query: string; sessionId: string }
  | { type: 'cancelSearch'; sessionId: string };

export type ExtensionToWebviewMessage =
  | { type: 'init'; data: CsvParseResult }
  | { type: 'update'; data: CsvParseResult }
  | { type: 'pageData'; page: number; pageSize: number; rows: string[][]; totalRows?: number }
  | { type: 'indexProgress'; totalRows: number; isComplete: boolean }
  | { type: 'searchBatch'; sessionId: string; matches: SearchMatchItem[]; scannedRatio: number; done: boolean; totalMatches?: number }
  | { type: 'error'; message: string }
  | { type: 'saveSuccess' }
  | { type: 'saveError'; message: string };
