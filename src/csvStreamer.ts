import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';
import { CsvParseOptions, SearchMatchItem } from './types';

export interface SniffResult {
  delimiter: string;
  headers: string[];
  initialRows: string[][];
  totalColumns: number;
  fileSize: number;
  isStreamMode: boolean;
  estimatedRows: number;
}

const STREAM_MODE_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5 MB threshold for large-file streaming mode
const CHUNK_SIZE = 64 * 1024; // 64 KB read buffer

/**
 * Quick-sniff the file: reads up to 128KB to detect delimiter, extract headers,
 * and fetch the first batch of rows for immediate display (<50ms).
 */
export async function sniffFile(
  filePath: string,
  options: CsvParseOptions = {}
): Promise<SniffResult> {
  const stats = await fs.promises.stat(filePath);
  const fileSize = stats.size;
  const isStreamMode = fileSize > STREAM_MODE_SIZE_THRESHOLD;

  // Read first chunk (up to 128 KB)
  const bytesToRead = Math.min(fileSize, 128 * 1024);
  const fd = await fs.promises.open(filePath, 'r');
  const buffer = Buffer.alloc(bytesToRead);
  await fd.read(buffer, 0, bytesToRead, 0);
  await fd.close();

  const previewText = buffer.toString('utf-8');
  const parseConfig: Papa.ParseConfig = {
    skipEmptyLines: 'greedy',
    delimiter: options.delimiter && options.delimiter !== 'auto' ? options.delimiter : undefined,
    preview: 51, // Sniff header + initial 50 rows for default page size of 50
  };

  const parsed = Papa.parse<string[]>(previewText, parseConfig);
  const detectedDelimiter = parsed.meta?.delimiter || ',';
  const data: string[][] = parsed.data || [];

  let maxCols = 0;
  for (const row of data) {
    if (Array.isArray(row) && row.length > maxCols) {
      maxCols = row.length;
    }
  }

  const useFirstRowAsHeader = options.hasHeader !== undefined ? options.hasHeader : true;
  let headers: string[] = [];
  let rawRows: string[][] = [];

  if (useFirstRowAsHeader && data.length > 0) {
    const rawHeaderRow = data[0];
    for (let i = 0; i < maxCols; i++) {
      const headerVal = (rawHeaderRow[i] ?? '').trim();
      headers.push(headerVal.length > 0 ? headerVal : `Column ${i + 1}`);
    }
    rawRows = data.slice(1);
  } else {
    for (let i = 0; i < maxCols; i++) {
      headers.push(`Column ${i + 1}`);
    }
    rawRows = data;
  }

  // Normalize initial preview rows (default page size 50)
  const initialRows = rawRows.slice(0, 50).map((row) => {
    const safeRow: string[] = [];
    for (let i = 0; i < maxCols; i++) {
      safeRow.push(row[i] !== undefined && row[i] !== null ? String(row[i]) : '');
    }
    return safeRow;
  });

  // Calculate estimated rows based on average bytes per row in sample
  const sampleBytes = buffer.length;
  const sampleRowCount = Math.max(1, data.length);
  const avgRowBytes = Math.max(10, sampleBytes / sampleRowCount);
  const estimatedRows = Math.max(initialRows.length, Math.round(fileSize / avgRowBytes));

  return {
    delimiter: detectedDelimiter,
    headers,
    initialRows,
    totalColumns: maxCols,
    fileSize,
    isStreamMode,
    estimatedRows,
  };
}

/**
 * Manages background byte-offset indexing, random-access page retrieval,
 * streaming progressive search, and atomic delta saving for large CSV files.
 */
export class CsvStreamIndexer {
  private readonly filePath: string;
  private readonly fileSize: number;
  private readonly hasHeader: boolean;
  private readonly delimiter: string;
  private readonly totalColumns: number;

  // Stores byte offset where each row starts
  private rowOffsets: number[] = [];
  private isIndexing: boolean = false;
  private indexingDone: boolean = false;
  private indexingPromise: Promise<number> | null = null;
  private indexAbortController: AbortController | null = null;

  constructor(
    filePath: string,
    fileSize: number,
    options: { hasHeader?: boolean; delimiter?: string; totalColumns?: number } = {}
  ) {
    this.filePath = filePath;
    this.fileSize = fileSize;
    this.hasHeader = options.hasHeader ?? true;
    this.delimiter = options.delimiter ?? ',';
    this.totalColumns = options.totalColumns ?? 0;
  }

  public get totalDataRows(): number {
    if (this.rowOffsets.length === 0) return 0;
    return this.hasHeader ? Math.max(0, this.rowOffsets.length - 1) : this.rowOffsets.length;
  }

  public get isComplete(): boolean {
    return this.indexingDone;
  }

  /**
   * Starts background byte-offset indexing without blocking the event loop.
   */
  public startIndexing(onProgress?: (totalRows: number, isComplete: boolean) => void): Promise<number> {
    if (this.indexingPromise) {
      return this.indexingPromise;
    }

    this.isIndexing = true;
    this.indexAbortController = new AbortController();

    this.indexingPromise = new Promise<number>((resolve, reject) => {
      this.rowOffsets = [0]; // First row starts at byte 0
      let inQuotes = false;
      let globalOffset = 0;
      let lastReportTime = Date.now();

      const stream = fs.createReadStream(this.filePath, {
        highWaterMark: CHUNK_SIZE,
        signal: this.indexAbortController?.signal,
      });

      stream.on('data', (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const len = buf.length;
        for (let i = 0; i < len; i++) {
          const byte = buf[i];
          if (byte === 34) {
            // Quote character "
            inQuotes = !inQuotes;
          } else if (!inQuotes && byte === 10) {
            // Newline outside quotes marks row start
            const nextOffset = globalOffset + i + 1;
            if (nextOffset < this.fileSize) {
              this.rowOffsets.push(nextOffset);
            }
          }
        }
        globalOffset += len;

        const now = Date.now();
        if (now - lastReportTime > 250) {
          lastReportTime = now;
          if (onProgress) {
            onProgress(this.totalDataRows, false);
          }
        }
      });

      stream.on('end', () => {
        this.isIndexing = false;
        this.indexingDone = true;
        if (onProgress) {
          onProgress(this.totalDataRows, true);
        }
        resolve(this.totalDataRows);
      });

      stream.on('error', (err) => {
        this.isIndexing = false;
        if (this.indexAbortController?.signal.aborted) {
          resolve(this.totalDataRows);
        } else {
          reject(err);
        }
      });
    });

    return this.indexingPromise;
  }

  /**
   * Random-access page retrieval. Seeks directly to the row's byte offset,
   * reads only the requested slice, and parses rows in ~1-5ms.
   */
  public async getPage(page: number, pageSize: number): Promise<{ rows: string[][]; totalRows: number }> {
    // If indexing is still running, wait for enough rows to be indexed
    const startRowIdx = (page - 1) * pageSize;
    const endRowIdx = startRowIdx + pageSize;

    const physicalStartIdx = this.hasHeader ? startRowIdx + 1 : startRowIdx;
    const physicalEndIdx = this.hasHeader ? endRowIdx + 1 : endRowIdx;

    if (physicalStartIdx >= this.rowOffsets.length) {
      if (!this.indexingDone && this.indexingPromise) {
        await this.indexingPromise;
      }
    }

    if (physicalStartIdx >= this.rowOffsets.length) {
      return { rows: [], totalRows: this.totalDataRows };
    }

    const startByte = this.rowOffsets[physicalStartIdx];
    const endByte = physicalEndIdx < this.rowOffsets.length
      ? this.rowOffsets[physicalEndIdx]
      : this.fileSize;

    const sliceLength = Math.max(0, endByte - startByte);
    if (sliceLength === 0) {
      return { rows: [], totalRows: this.totalDataRows };
    }

    const fd = await fs.promises.open(this.filePath, 'r');
    const buffer = Buffer.alloc(sliceLength);
    await fd.read(buffer, 0, sliceLength, startByte);
    await fd.close();

    const rawChunk = buffer.toString('utf-8');
    const parsed = Papa.parse<string[]>(rawChunk, {
      delimiter: this.delimiter,
      skipEmptyLines: 'greedy',
    });

    const parsedRows = parsed.data || [];
    const normalizedRows = parsedRows.map((row) => {
      const safe: string[] = [];
      const cols = Math.max(this.totalColumns, row.length);
      for (let c = 0; c < cols; c++) {
        safe.push(row[c] !== undefined && row[c] !== null ? String(row[c]) : '');
      }
      return safe;
    });

    return {
      rows: normalizedRows,
      totalRows: this.totalDataRows,
    };
  }

  /**
   * High-speed streaming search across the entire CSV file.
   * Uses raw string pre-filtering to skip unmatching lines without full parsing,
   * yielding real-time progressive results pushed in batches.
   */
  public streamingSearch(
    query: string,
    onBatch: (batch: SearchMatchItem[], scannedRatio: number, done: boolean) => void,
    signal?: AbortSignal
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const trimmed = query.trim().toLowerCase();
      if (!trimmed) {
        onBatch([], 1, true);
        resolve(0);
        return;
      }

      const stream = fs.createReadStream(this.filePath, {
        highWaterMark: CHUNK_SIZE,
        signal,
      });

      let remainder = Buffer.alloc(0);
      let globalDataRow = 0;
      let totalMatches = 0;
      let isFirstRow = true;
      let currentBatch: SearchMatchItem[] = [];
      let bytesRead = 0;
      let lastBatchPush = Date.now();

      const pushBatch = (isDone: boolean) => {
        const ratio = this.fileSize > 0 ? Math.min(1, bytesRead / this.fileSize) : 1;
        onBatch(currentBatch, ratio, isDone);
        currentBatch = [];
        lastBatchPush = Date.now();
      };

      stream.on('data', (chunk: Buffer | string) => {
        if (signal?.aborted) {
          stream.destroy();
          return;
        }

        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytesRead += buf.length;
        const combined = Buffer.concat([remainder, buf]);
        let lastRowStart = 0;
        let inQuotes = false;

        for (let i = 0; i < combined.length; i++) {
          const byte = combined[i];
          if (byte === 34) {
            inQuotes = !inQuotes;
          } else if (!inQuotes && byte === 10) {
            const lineBuf = combined.subarray(lastRowStart, i);
            lastRowStart = i + 1;

            if (isFirstRow && this.hasHeader) {
              isFirstRow = false;
              continue; // Skip header row
            }
            isFirstRow = false;

            const rowNumber = globalDataRow++;
            const lineText = lineBuf.toString('utf-8').replace(/\r$/, '');

            // Fast raw-string pre-filter: check if query appears in line
            if (lineText.toLowerCase().includes(trimmed)) {
              // Parse this specific matching line
              const parsed = Papa.parse<string[]>(lineText, {
                delimiter: this.delimiter,
                skipEmptyLines: 'greedy',
              });
              const rowData = parsed.data?.[0];
              if (rowData && rowData.some((cell) => String(cell || '').toLowerCase().includes(trimmed))) {
                currentBatch.push({ rowNumber, row: rowData });
                totalMatches++;
              }
            }

            // Push batch if we collected 50 matches or every 100ms
            const now = Date.now();
            if (currentBatch.length >= 50 || (currentBatch.length > 0 && now - lastBatchPush > 100)) {
              pushBatch(false);
            }
          }
        }

        remainder = combined.subarray(lastRowStart);
      });

      stream.on('end', () => {
        // Handle last remaining line if any
        if (remainder.length > 0 && !signal?.aborted) {
          const lineText = remainder.toString('utf-8').replace(/\r$/, '');
          if (lineText.toLowerCase().includes(trimmed)) {
            const parsed = Papa.parse<string[]>(lineText, {
              delimiter: this.delimiter,
              skipEmptyLines: 'greedy',
            });
            const rowData = parsed.data?.[0];
            if (rowData && rowData.some((cell) => String(cell || '').toLowerCase().includes(trimmed))) {
              currentBatch.push({ rowNumber: globalDataRow++, row: rowData });
              totalMatches++;
            }
          }
        }

        pushBatch(true);
        resolve(totalMatches);
      });

      stream.on('error', (err) => {
        if (signal?.aborted) {
          pushBatch(true);
          resolve(totalMatches);
        } else {
          reject(err);
        }
      });
    });
  }

  /**
   * Saves cell modifications to large CSV files using a streaming pipeline.
   * Rewrites only modified rows at their corresponding line index, using <10MB RAM.
   */
  public async saveDeltaEdits(
    modifiedRows: Record<number, string[]>,
    headers: string[]
  ): Promise<void> {
    const tempPath = `${this.filePath}.tmp.${Date.now()}`;
    const writeStream = fs.createWriteStream(tempPath, { encoding: 'utf-8' });
    const readStream = fs.createReadStream(this.filePath, { highWaterMark: CHUNK_SIZE });

    let remainder = Buffer.alloc(0);
    let rowIndex = -1; // -1 represents header row if hasHeader is true
    let isHeaderProcessed = !this.hasHeader;

    const writeRow = async (cells: string[]) => {
      const unparsed = Papa.unparse([cells], { delimiter: this.delimiter });
      if (!writeStream.write(unparsed + '\n')) {
        await new Promise<void>((res) => writeStream.once('drain', () => res()));
      }
    };

    // If hasHeader, write updated headers first
    if (this.hasHeader) {
      await writeRow(headers);
    }

    try {
      for await (const chunk of readStream) {
        const combined = Buffer.concat([remainder, chunk]);
        let lastRowStart = 0;
        let inQuotes = false;

        for (let i = 0; i < combined.length; i++) {
          const byte = combined[i];
          if (byte === 34) {
            inQuotes = !inQuotes;
          } else if (!inQuotes && byte === 10) {
            const lineBuf = combined.subarray(lastRowStart, i);
            lastRowStart = i + 1;

            if (!isHeaderProcessed && this.hasHeader) {
              isHeaderProcessed = true;
              continue; // Original header line skipped because we wrote updated headers above
            }

            rowIndex++;
            if (modifiedRows[rowIndex] !== undefined) {
              // Write the modified row
              await writeRow(modifiedRows[rowIndex]);
            } else {
              // Write the untouched original row line as-is
              const originalLine = lineBuf.toString('utf-8').replace(/\r$/, '');
              if (!writeStream.write(originalLine + '\n')) {
                await new Promise<void>((res) => writeStream.once('drain', () => res()));
              }
            }
          }
        }
        remainder = combined.subarray(lastRowStart);
      }

      // Trailing line if any
      if (remainder.length > 0) {
        if (!isHeaderProcessed && this.hasHeader) {
          isHeaderProcessed = true;
        } else {
          rowIndex++;
          if (modifiedRows[rowIndex] !== undefined) {
            await writeRow(modifiedRows[rowIndex]);
          } else {
            const originalLine = remainder.toString('utf-8').replace(/\r$/, '');
            if (originalLine.trim().length > 0) {
              writeStream.write(originalLine + '\n');
            }
          }
        }
      }

      await new Promise<void>((resolve, reject) => {
        writeStream.end(() => resolve());
        writeStream.on('error', reject);
      });

      // Atomic rename
      await fs.promises.rename(tempPath, this.filePath);
    } catch (err) {
      // Clean up temp file on failure
      try {
        if (fs.existsSync(tempPath)) {
          await fs.promises.unlink(tempPath);
        }
      } catch {
        // ignore
      }
      throw err;
    }
  }

  public dispose(): void {
    if (this.indexAbortController) {
      this.indexAbortController.abort();
    }
  }
}
