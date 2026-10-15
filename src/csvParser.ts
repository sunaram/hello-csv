import Papa from 'papaparse';
import { CsvParseOptions, CsvParseResult } from './types';

/**
 * Converts a 0-based column index to Excel-style letters (0 -> A, 1 -> B, 26 -> AA, etc.)
 */
export function getColumnLetter(index: number): string {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

/**
 * Parses raw CSV/TSV text into structured CsvParseResult
 */
export function parseCsv(
  content: string,
  fileName: string,
  options: CsvParseOptions = {}
): CsvParseResult {
  const parseConfig: Papa.ParseConfig = {
    skipEmptyLines: 'greedy',
    delimiter: options.delimiter && options.delimiter !== 'auto' ? options.delimiter : undefined,
  };

  const parsed = Papa.parse<string[]>(content, parseConfig);
  const data: string[][] = parsed.data || [];
  const detectedDelimiter = parsed.meta?.delimiter || ',';
  const errors = parsed.errors?.map((e) => `Line ${e.row ?? '?'}: ${e.message}`) || [];

  if (data.length === 0) {
    return {
      headers: [],
      rows: [],
      totalRows: 0,
      totalColumns: 0,
      delimiter: detectedDelimiter,
      fileName,
      errors,
    };
  }

  // Calculate maximum column count across all rows
  let maxCols = 0;
  for (const row of data) {
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }

  const useFirstRowAsHeader = options.hasHeader !== undefined ? options.hasHeader : true;

  let headers: string[] = [];
  let rows: string[][] = [];

  if (useFirstRowAsHeader && data.length > 0) {
    const rawHeaderRow = data[0];
    headers = [];
    for (let i = 0; i < maxCols; i++) {
      const headerVal = (rawHeaderRow[i] ?? '').trim();
      headers.push(headerVal.length > 0 ? headerVal : `Column ${i + 1}`);
    }
    rows = data.slice(1);
  } else {
    // Generate headers like Column 1 (A), Column 2 (B)...
    headers = [];
    for (let i = 0; i < maxCols; i++) {
      headers.push(`Column ${i + 1}`);
    }
    rows = data;
  }

  // Normalize all rows to have exact maxCols columns
  const normalizedRows = rows.map((row) => {
    const safeRow: string[] = [];
    for (let i = 0; i < maxCols; i++) {
      safeRow.push(row[i] !== undefined && row[i] !== null ? String(row[i]) : '');
    }
    return safeRow;
  });

  return {
    headers,
    rows: normalizedRows,
    totalRows: normalizedRows.length,
    totalColumns: maxCols,
    delimiter: detectedDelimiter,
    fileName,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Format headers and rows as a Markdown table
 */
export function formatAsMarkdown(headers: string[], rows: string[][]): string {
  if (headers.length === 0 && rows.length === 0) {
    return '';
  }

  const cols = headers.length > 0 ? headers.length : (rows[0]?.length || 0);
  const effectiveHeaders = headers.length > 0
    ? headers
    : Array.from({ length: cols }, (_, i) => `Col ${i + 1}`);

  const escapeCell = (str: string) => (str || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

  const headerLine = `| ${effectiveHeaders.map(escapeCell).join(' | ')} |`;
  const separatorLine = `| ${effectiveHeaders.map(() => '---').join(' | ')} |`;

  const dataLines = rows.map((row) => {
    const cells = effectiveHeaders.map((_, i) => escapeCell(row[i] ?? ''));
    return `| ${cells.join(' | ')} |`;
  });

  return [headerLine, separatorLine, ...dataLines].join('\n');
}

/**
 * Format headers and rows as Tab-Separated Values (TSV)
 */
export function formatAsTsv(headers: string[], rows: string[][]): string {
  const escapeCell = (val: string) => {
    const text = val ?? '';
    if (text.includes('\t') || text.includes('\n') || text.includes('"')) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };

  const lines: string[] = [];
  if (headers.length > 0) {
    lines.push(headers.map(escapeCell).join('\t'));
  }
  for (const row of rows) {
    lines.push(row.map(escapeCell).join('\t'));
  }
  return lines.join('\n');
}

/**
 * Serializes headers and rows back into CSV/TSV string format
 */
export function unparseCsv(
  headers: string[],
  rows: string[][],
  options: { delimiter?: string; hasHeader?: boolean } = {}
): string {
  const delimiter = options.delimiter && options.delimiter !== 'auto' ? options.delimiter : ',';
  const hasHeader = options.hasHeader !== undefined ? options.hasHeader : true;

  if (hasHeader && headers.length > 0) {
    return Papa.unparse(
      {
        fields: headers,
        data: rows,
      },
      {
        delimiter,
        newline: '\n',
      }
    );
  } else {
    return Papa.unparse(rows, {
      delimiter,
      newline: '\n',
    });
  }
}

