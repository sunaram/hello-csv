import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseCsv, unparseCsv, formatAsMarkdown, formatAsTsv } from './csvParser';
import { sniffFile, CsvStreamIndexer } from './csvStreamer';
import {
  CsvParseOptions,
  CsvParseResult,
  ExtensionToWebviewMessage,
  WebviewToExtensionMessage,
  SearchMatchItem,
} from './types';

export class CsvPreviewPanel {
  public static readonly viewType = 'helloCsv.preview';
  private static readonly currentPanels = new Map<string, CsvPreviewPanel>();

  private readonly panel: vscode.WebviewPanel;
  private readonly resourceUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];
  private currentOptions: CsvParseOptions = { hasHeader: true, delimiter: 'auto' };
  private cachedResult?: CsvParseResult;
  private isDirty: boolean = false;

  private streamer?: CsvStreamIndexer;
  private isStreamMode: boolean = false;
  private currentSearchAbort?: AbortController;

  public static createOrShow(resourceUri: vscode.Uri, viewColumn?: vscode.ViewColumn): CsvPreviewPanel {
    const key = resourceUri.toString();

    // If panel already exists, reveal it
    const existing = CsvPreviewPanel.currentPanels.get(key);
    if (existing) {
      existing.panel.reveal(viewColumn || existing.panel.viewColumn);
      return existing;
    }

    const fileName = path.basename(resourceUri.fsPath);
    const panel = vscode.window.createWebviewPanel(
      CsvPreviewPanel.viewType,
      `Hello CSV: ${fileName}`,
      viewColumn ?? vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [],
      }
    );

    const instance = new CsvPreviewPanel(panel, resourceUri);
    CsvPreviewPanel.currentPanels.set(key, instance);
    return instance;
  }

  private constructor(panel: vscode.WebviewPanel, resourceUri: vscode.Uri) {
    this.panel = panel;
    this.resourceUri = resourceUri;

    // Set panel icon
    this.panel.iconPath = new vscode.ThemeIcon('table');

    // Generate webview HTML
    this.panel.webview.html = this.getHtmlForWebview();

    // Listen for panel disposal
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    // Handle messages from the webview
    this.panel.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => this.handleMessage(message),
      null,
      this.disposables
    );

    // Watch for external document saves to auto-reload if not dirty
    const watcher = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.toString() === this.resourceUri.toString()) {
        if (!this.isDirty) {
          this.loadAndSendCsv();
        }
      }
    });
    this.disposables.push(watcher);
  }

  private async loadAndSendCsv(): Promise<void> {
    try {
      const fsPath = this.resourceUri.fsPath;
      const stats = await fs.promises.stat(fsPath);
      const fileName = path.basename(fsPath);

      // Clean up previous search or streamer if active
      if (this.currentSearchAbort) {
        this.currentSearchAbort.abort();
        this.currentSearchAbort = undefined;
      }
      if (this.streamer) {
        this.streamer.dispose();
        this.streamer = undefined;
      }

      // 5 MB threshold: larger files activate Virtual Streaming Mode
      const STREAM_THRESHOLD = 5 * 1024 * 1024;

      if (stats.size > STREAM_THRESHOLD) {
        this.isStreamMode = true;
        const sniff = await sniffFile(fsPath, this.currentOptions);

        this.streamer = new CsvStreamIndexer(fsPath, stats.size, {
          hasHeader: this.currentOptions.hasHeader ?? true,
          delimiter: sniff.delimiter,
          totalColumns: sniff.totalColumns,
        });

        this.setDirtyState(false);

        // Send instant first paint (<50ms)
        this.panel.webview.postMessage({
          type: 'init',
          data: {
            headers: sniff.headers,
            rows: sniff.initialRows,
            totalRows: sniff.estimatedRows,
            totalColumns: sniff.totalColumns,
            delimiter: sniff.delimiter,
            fileName,
            fileSize: stats.size,
            isStreamMode: true,
            isIndexing: true,
          },
        } as ExtensionToWebviewMessage);

        // Start background indexing of row offsets
        this.streamer.startIndexing((totalRows, isComplete) => {
          this.panel.webview.postMessage({
            type: 'indexProgress',
            totalRows,
            isComplete,
          } as ExtensionToWebviewMessage);
        });
      } else {
        // Direct In-Memory Mode for smaller files
        this.isStreamMode = false;
        const fileBytes = await vscode.workspace.fs.readFile(this.resourceUri);
        const content = new TextDecoder('utf-8').decode(fileBytes);
        const result = parseCsv(content, fileName, this.currentOptions);
        this.cachedResult = result;
        this.setDirtyState(false);

        this.panel.webview.postMessage({
          type: 'init',
          data: {
            ...result,
            isStreamMode: false,
            isIndexing: false,
          },
        } as ExtensionToWebviewMessage);
      }
    } catch (err: any) {
      const errorMessage = err?.message || String(err);
      this.panel.webview.postMessage({
        type: 'error',
        message: `Failed to load CSV: ${errorMessage}`,
      } as ExtensionToWebviewMessage);
    }
  }

  private setDirtyState(dirty: boolean): void {
    this.isDirty = dirty;
    const baseName = path.basename(this.resourceUri.fsPath);
    this.panel.title = dirty ? `● Hello CSV: ${baseName}` : `Hello CSV: ${baseName}`;
  }

  private async handleMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.loadAndSendCsv();
        break;

      case 'requestReload':
        if (message.delimiter !== undefined) {
          this.currentOptions.delimiter = message.delimiter;
        }
        if (message.hasHeader !== undefined) {
          this.currentOptions.hasHeader = message.hasHeader;
        }
        await this.loadAndSendCsv();
        break;

      case 'requestPage': {
        if (this.streamer && this.isStreamMode) {
          try {
            const { rows, totalRows } = await this.streamer.getPage(message.page, message.pageSize);
            this.panel.webview.postMessage({
              type: 'pageData',
              page: message.page,
              pageSize: message.pageSize,
              rows,
              totalRows,
            } as ExtensionToWebviewMessage);
          } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to fetch page ${message.page}: ${err?.message || err}`);
          }
        }
        break;
      }

      case 'startSearch': {
        if (this.streamer && this.isStreamMode) {
          if (this.currentSearchAbort) {
            this.currentSearchAbort.abort();
          }
          this.currentSearchAbort = new AbortController();
          const abortSignal = this.currentSearchAbort.signal;
          const sessionId = message.sessionId;

          this.streamer
            .streamingSearch(
              message.query,
              (batch, scannedRatio, done) => {
                if (!abortSignal.aborted) {
                  this.panel.webview.postMessage({
                    type: 'searchBatch',
                    sessionId,
                    matches: batch,
                    scannedRatio,
                    done,
                  } as ExtensionToWebviewMessage);
                }
              },
              abortSignal
            )
            .catch((err) => {
              if (!abortSignal.aborted) {
                console.error('Streaming search error:', err);
              }
            });
        }
        break;
      }

      case 'cancelSearch': {
        if (this.currentSearchAbort) {
          this.currentSearchAbort.abort();
          this.currentSearchAbort = undefined;
        }
        break;
      }

      case 'setDirty':
        this.setDirtyState(message.isDirty);
        break;

      case 'saveData': {
        try {
          const csvContent = unparseCsv(message.headers, message.rows, {
            delimiter: message.delimiter,
            hasHeader: message.hasHeader,
          });

          // Write back using WorkspaceEdit if document is known, or fs.writeFile
          let saved = false;
          try {
            const document = await vscode.workspace.openTextDocument(this.resourceUri);
            const fullRange = new vscode.Range(
              document.positionAt(0),
              document.positionAt(document.getText().length)
            );
            const edit = new vscode.WorkspaceEdit();
            edit.replace(this.resourceUri, fullRange, csvContent);
            const applied = await vscode.workspace.applyEdit(edit);
            if (applied) {
              await document.save();
              saved = true;
            }
          } catch {
            // fallback below
          }

          if (!saved) {
            const enc = new TextEncoder();
            await vscode.workspace.fs.writeFile(this.resourceUri, enc.encode(csvContent));
          }

          this.setDirtyState(false);
          this.panel.webview.postMessage({ type: 'saveSuccess' } as ExtensionToWebviewMessage);
          vscode.window.showInformationMessage(`Saved ${path.basename(this.resourceUri.fsPath)} successfully!`);
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          vscode.window.showErrorMessage(`Failed to save CSV: ${errMsg}`);
          this.panel.webview.postMessage({
            type: 'saveError',
            message: errMsg,
          } as ExtensionToWebviewMessage);
        }
        break;
      }

      case 'saveDelta': {
        try {
          if (this.streamer && this.isStreamMode) {
            await this.streamer.saveDeltaEdits(message.modifiedRows, message.headers);
            this.setDirtyState(false);
            this.panel.webview.postMessage({ type: 'saveSuccess' } as ExtensionToWebviewMessage);
            vscode.window.showInformationMessage(`Saved ${path.basename(this.resourceUri.fsPath)} successfully!`);
          }
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          vscode.window.showErrorMessage(`Failed to save CSV changes: ${errMsg}`);
          this.panel.webview.postMessage({
            type: 'saveError',
            message: errMsg,
          } as ExtensionToWebviewMessage);
        }
        break;
      }

      case 'copyToClipboard': {
        try {
          await vscode.env.clipboard.writeText(message.text);
          const formatLabel =
            message.format === 'markdown'
              ? 'Markdown table'
              : message.format === 'tsv'
              ? 'TSV'
              : 'Cell value';
          vscode.window.showInformationMessage(`${formatLabel} copied to clipboard!`);
        } catch (err: any) {
          vscode.window.showErrorMessage(`Failed to copy to clipboard: ${err?.message || err}`);
        }
        break;
      }

      case 'showInfo':
        vscode.window.showInformationMessage(message.message);
        break;

      case 'showError':
        vscode.window.showErrorMessage(message.message);
        break;
    }
  }

  public dispose(): void {
    const key = this.resourceUri.toString();
    CsvPreviewPanel.currentPanels.delete(key);

    if (this.currentSearchAbort) {
      this.currentSearchAbort.abort();
    }
    if (this.streamer) {
      this.streamer.dispose();
    }

    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) {
        d.dispose();
      }
    }
  }

  private getHtmlForWebview(): string {
    const cspSource = this.panel.webview.cspSource;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${cspSource}; script-src 'unsafe-inline' ${cspSource};">
  <title>Hello CSV</title>
  <style>
    :root {
      --font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif);
      --font-size: var(--vscode-font-size, 13px);
      --border-color: var(--vscode-panel-border, rgba(128, 128, 128, 0.25));
      --header-bg: var(--vscode-editorGroupHeader-tabsBackground, rgba(0, 0, 0, 0.08));
      --row-even-bg: transparent;
      --row-odd-bg: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.04));
      --row-hover-bg: var(--vscode-list-activeSelectionBackground, rgba(0, 120, 215, 0.15));
      --text-muted: var(--vscode-descriptionForeground, #888);
      --highlight-bg: var(--vscode-editor-findMatchHighlightBackground, #e0a800);
      --highlight-fg: var(--vscode-editor-findMatchForeground, #000);
      --modified-color: var(--vscode-editorWarning-foreground, #e5a50a);
      --focus-color: var(--vscode-focusBorder, #007acc);
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font-family);
      font-size: var(--font-size);
      color: var(--vscode-editor-foreground, #ccc);
      background-color: var(--vscode-editor-background, #1e1e1e);
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
      user-select: text;
    }

    /* Top Main Toolbar */
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      padding: 6px 12px;
      background-color: var(--vscode-sideBar-background, rgba(0,0,0,0.03));
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .toolbar-group {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Cell Formula / Value Bar */
    .cell-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px;
      background-color: var(--vscode-editorGroupHeader-tabsBackground, rgba(0,0,0,0.06));
      border-bottom: 1px solid var(--border-color);
      flex-shrink: 0;
    }

    .cell-badge {
      font-family: var(--font-family);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      border-radius: 3px;
      min-width: 48px;
      text-align: center;
      user-select: none;
    }

    .cell-bar-input {
      flex: 1;
      padding: 4px 8px;
      background: var(--vscode-input-background, #2d2d2d);
      color: var(--vscode-input-foreground, var(--vscode-editor-foreground, #fff));
      border: 1px solid var(--vscode-input-border, var(--border-color));
      border-radius: 3px;
      font-size: 12px;
      font-family: inherit;
      outline: none;
    }

    .cell-bar-input:focus {
      border-color: var(--focus-color);
    }

    .search-box {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-input {
      padding: 4px 24px 4px 8px;
      background: var(--vscode-input-background, #2d2d2d);
      color: var(--vscode-input-foreground, var(--vscode-editor-foreground, #fff));
      border: 1px solid var(--vscode-input-border, var(--border-color));
      border-radius: 3px;
      font-size: 12px;
      outline: none;
      width: 170px;
      transition: width 0.15s ease, border-color 0.15s ease;
    }

    .search-input:focus {
      border-color: var(--focus-color);
      width: 220px;
    }

    .search-clear {
      position: absolute;
      right: 6px;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1;
      display: none;
    }

    .search-indicator {
      display: none;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--vscode-editorInfo-foreground, #3794ff);
    }

    .search-spinner {
      width: 12px;
      height: 12px;
      border: 2px solid rgba(128, 128, 128, 0.3);
      border-top-color: var(--focus-color);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }


    .btn, select {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ffffff);
      border: 1px solid var(--vscode-button-border, transparent);
      padding: 4px 8px;
      border-radius: 3px;
      font-size: 12px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      outline: none;
    }

    .btn:hover, select:hover {
      background: var(--vscode-button-secondaryHoverBackground, #45494e);
    }

    .btn-save {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #ffffff);
      font-weight: 600;
    }

    .btn-save:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }

    .btn-save.dirty {
      background: #198754 !important;
      color: #fff !important;
      box-shadow: 0 0 6px rgba(25, 135, 84, 0.6);
    }

    .btn-save.dirty:hover {
      background: #157347 !important;
    }

    .btn:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    select {
      padding: 3px 6px;
    }

    .dirty-badge {
      display: none;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--modified-color);
      font-weight: 600;
    }

    .dirty-badge.visible {
      display: inline-flex;
    }

    .stats-label {
      color: var(--text-muted);
      font-size: 12px;
      margin-left: auto;
      white-space: nowrap;
    }

    .checkbox-label {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 12px;
      cursor: pointer;
      color: var(--vscode-editor-foreground);
    }

    /* Table Container */
    .table-container {
      flex: 1;
      overflow: auto;
      position: relative;
      background: var(--vscode-editor-background);
    }

    table {
      border-collapse: separate;
      border-spacing: 0;
      width: max-content;
      min-width: 100%;
      font-size: 12px;
    }

    th, td {
      padding: 5px 10px;
      border-right: 1px solid var(--border-color);
      border-bottom: 1px solid var(--border-color);
      white-space: nowrap;
      text-overflow: ellipsis;
      max-width: 450px;
      overflow: hidden;
      position: relative;
    }

    /* Sticky Header */
    thead th {
      position: sticky;
      top: 0;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      color: var(--vscode-editor-foreground);
      font-weight: 600;
      z-index: 10;
      user-select: none;
      box-shadow: 0 1px 0 var(--border-color);
    }

    thead th:hover {
      background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.15));
    }

    .header-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      cursor: pointer;
    }

    .col-letter {
      font-size: 9px;
      color: var(--text-muted);
      font-weight: normal;
      margin-right: 4px;
    }

    .sort-indicator {
      font-size: 10px;
      color: var(--focus-color);
      display: inline-block;
      width: 12px;
      text-align: center;
    }

    /* Sticky Row Index Column */
    .row-index {
      position: sticky;
      left: 0;
      background: var(--vscode-editorGutter-background, var(--vscode-editor-background));
      color: var(--text-muted);
      text-align: right;
      font-variant-numeric: tabular-nums;
      width: 44px;
      min-width: 44px;
      max-width: 75px;
      user-select: none;
      font-size: 11px;
      z-index: 5;
    }

    thead th.row-index {
      z-index: 20;
      background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
      text-align: center;
      cursor: default;
    }

    /* Row striping and hover */
    tbody tr:nth-child(even) {
      background-color: var(--row-odd-bg);
    }

    tbody tr:nth-child(odd) {
      background-color: var(--row-even-bg);
    }

    tbody tr:hover {
      background-color: var(--row-hover-bg);
    }

    tbody tr:hover .row-index {
      background-color: var(--row-hover-bg);
      color: var(--vscode-editor-foreground);
    }

    /* Selected cell */
    td.selected {
      outline: 2px solid var(--focus-color);
      outline-offset: -2px;
    }

    /* Modified Cell Marker */
    td.cell-modified {
      background-color: rgba(204, 167, 0, 0.14) !important;
    }

    td.cell-modified::after {
      content: '';
      position: absolute;
      top: 0;
      right: 0;
      border-width: 0 6px 6px 0;
      border-style: solid;
      border-color: var(--modified-color) transparent;
      pointer-events: none;
    }

    /* In-place contenteditable editing cell */
    td.editing {
      outline: 2px solid var(--focus-color) !important;
      outline-offset: -2px;
      background: var(--vscode-input-background, #2d2d2d) !important;
      color: var(--vscode-input-foreground, var(--vscode-editor-foreground, #fff)) !important;
      user-select: text !important;
      cursor: text !important;
      white-space: pre !important;
      overflow: visible !important;
      z-index: 15;
    }

    mark {
      background: var(--highlight-bg);
      color: var(--highlight-fg);
      padding: 0 1px;
      border-radius: 2px;
    }

    /* Footer / Pagination */
    .footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 5px 12px;
      background: var(--vscode-statusBar-background, rgba(0, 0, 0, 0.05));
      border-top: 1px solid var(--border-color);
      flex-shrink: 0;
      font-size: 12px;
    }

    .pagination {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .page-info {
      color: var(--vscode-editor-foreground);
      font-size: 12px;
      margin: 0 4px;
    }

    /* Empty / Status State */
    .status-overlay {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: absolute;
      inset: 0;
      background: var(--vscode-editor-background);
      color: var(--text-muted);
      font-size: 14px;
      gap: 12px;
      z-index: 30;
    }

    .status-overlay.hidden {
      display: none;
    }

    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid rgba(128, 128, 128, 0.2);
      border-top-color: var(--focus-color);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <!-- Top Main Toolbar -->
  <div class="toolbar">
    <div class="toolbar-group">
      <div class="search-box">
        <input type="text" id="searchInput" class="search-input" placeholder="Search / filter rows..." />
        <span id="searchClear" class="search-clear">&times;</span>
      </div>
      <div id="searchIndicator" class="search-indicator">
        <span class="search-spinner"></span>
        <span id="searchProgressText">Searching...</span>
      </div>
    </div>

    <!-- Edit Actions -->
    <div class="toolbar-group">
      <button id="saveBtn" class="btn btn-save" title="Save changes to file (Ctrl+S)" disabled>
        💾 Save
      </button>
      <button id="revertBtn" class="btn" title="Discard unsaved edits" disabled>
        ↩ Revert
      </button>
      <button id="addRowBtn" class="btn" title="Add a new row">
        + Row
      </button>
      <button id="delRowBtn" class="btn" title="Delete selected row" disabled>
        - Row
      </button>
      <button id="addColBtn" class="btn" title="Add a new column">
        + Col
      </button>
    </div>

    <div class="toolbar-group">
      <span id="dirtyBadge" class="dirty-badge">● Unsaved edits</span>
    </div>

    <div class="toolbar-group">
      <label class="checkbox-label" title="Treat first row as column header names">
        <input type="checkbox" id="headerCheckbox" checked />
        <span>Header Row</span>
      </label>
    </div>

    <div class="toolbar-group">
      <label for="delimiterSelect" style="font-size: 11px; color: var(--text-muted);">Delimiter:</label>
      <select id="delimiterSelect" title="Select CSV Delimiter">
        <option value="auto">Auto</option>
        <option value=",">Comma (,)</option>
        <option value=";">Semicolon (;)</option>
        <option value="&#9;">Tab (\\t)</option>
        <option value="|">Pipe (|)</option>
      </select>
    </div>

    <div class="toolbar-group">
      <button id="copyMdBtn" class="btn" title="Copy current view as Markdown">
        Copy MD
      </button>
      <button id="copyTsvBtn" class="btn" title="Copy current view as TSV (for Excel/Sheets)">
        Copy TSV
      </button>
    </div>

    <div class="stats-label" id="statsLabel">Loading...</div>
  </div>

  <!-- Cell Formula / Value Bar -->
  <div class="cell-bar">
    <span class="cell-badge" id="cellAddressBadge">-</span>
    <input type="text" id="cellBarInput" class="cell-bar-input" placeholder="Click any cell to edit here or double-click to edit in-place..." disabled />
  </div>

  <!-- Table Viewport -->
  <div class="table-container" id="tableContainer">
    <div id="statusOverlay" class="status-overlay">
      <div class="spinner"></div>
      <span id="statusMessage">Loading CSV data...</span>
    </div>

    <table id="csvTable">
      <thead id="tableHead"></thead>
      <tbody id="tableBody"></tbody>
    </table>
  </div>

  <!-- Footer Pagination -->
  <div class="footer">
    <div class="toolbar-group">
      <span id="cellInfo" style="color: var(--text-muted);">Tip: Double-click or press Enter to edit cell &bull; Ctrl+S to save</span>
    </div>

    <div class="pagination">
      <label for="pageSizeSelect" style="color: var(--text-muted);">Page size:</label>
      <select id="pageSizeSelect">
        <option value="25">25</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
        <option value="250">250</option>
        <option value="1000">1000</option>
        <option value="-1">All (max 10,000)</option>
      </select>

      <button id="firstPageBtn" class="btn" title="First Page">&laquo;</button>
      <button id="prevPageBtn" class="btn" title="Previous Page">&lsaquo;</button>
      <span class="page-info" id="pageInfo">Page 1 of 1</span>
      <button id="nextPageBtn" class="btn" title="Next Page">&rsaquo;</button>
      <button id="lastPageBtn" class="btn" title="Last Page">&raquo;</button>
    </div>
  </div>

  <script>
    (function() {
      const vscode = acquireVsCodeApi();

      // State
      let csvData = null;
      let initialSnapshot = null;
      let isStreamMode = false;
      let isIndexing = false;

      // Edit tracking: modifiedCells (Set of "rawRow:col"), modifiedRows (Map of rawRow -> rowData)
      let modifiedCells = new Set();
      let modifiedRows = new Map();
      let undoStack = [];
      let redoStack = [];

      // Pagination & Filter State
      let filteredRowIndices = []; // For in-memory mode
      let searchMatches = []; // For stream mode: array of { rowNumber, row }
      let isSearching = false;
      let searchSessionId = '';
      let searchDebounceTimer = null;

      let currentPage = 1;
      let pageSize = 50;
      let sortColumn = -1; // -1 = natural order
      let sortDirection = 'asc'; // 'asc' | 'desc'
      let searchQuery = '';

      let selectedRawRow = -1;
      let selectedCol = -1;
      let activeEditingTd = null;
      let activeEditingInitialValue = '';
      const MAX_ALL_PAGE_SIZE = 10000;

      // Elements
      const searchInput = document.getElementById('searchInput');
      const searchClear = document.getElementById('searchClear');
      const searchIndicator = document.getElementById('searchIndicator');
      const searchProgressText = document.getElementById('searchProgressText');

      const cellAddressBadge = document.getElementById('cellAddressBadge');
      const cellBarInput = document.getElementById('cellBarInput');
      const headerCheckbox = document.getElementById('headerCheckbox');
      const delimiterSelect = document.getElementById('delimiterSelect');
      const saveBtn = document.getElementById('saveBtn');
      const revertBtn = document.getElementById('revertBtn');
      const addRowBtn = document.getElementById('addRowBtn');
      const delRowBtn = document.getElementById('delRowBtn');
      const addColBtn = document.getElementById('addColBtn');
      const dirtyBadge = document.getElementById('dirtyBadge');
      const copyMdBtn = document.getElementById('copyMdBtn');
      const copyTsvBtn = document.getElementById('copyTsvBtn');
      const statsLabel = document.getElementById('statsLabel');
      const statusOverlay = document.getElementById('statusOverlay');
      const statusMessage = document.getElementById('statusMessage');
      const tableHead = document.getElementById('tableHead');
      const tableBody = document.getElementById('tableBody');
      const pageSizeSelect = document.getElementById('pageSizeSelect');
      const firstPageBtn = document.getElementById('firstPageBtn');
      const prevPageBtn = document.getElementById('prevPageBtn');
      const nextPageBtn = document.getElementById('nextPageBtn');
      const lastPageBtn = document.getElementById('lastPageBtn');
      const pageInfo = document.getElementById('pageInfo');
      const cellInfo = document.getElementById('cellInfo');
      const tableContainer = document.getElementById('tableContainer');

      // Helper: Column letters (0 -> A, 1 -> B, ...)
      function getColLetter(idx) {
        let s = '';
        let t = idx;
        while (t >= 0) {
          s = String.fromCharCode((t % 26) + 65) + s;
          t = Math.floor(t / 26) - 1;
        }
        return s;
      }

      function escapeHtml(str) {
        if (!str && str !== 0) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function highlightText(text, query) {
        const str = String(text ?? '');
        if (!query) return escapeHtml(str);
        const escapedQuery = query.replace(/[-[\\]{}()*+?.,\\\\^$|#\\s]/g, '\\\\$&');
        const regex = new RegExp('(' + escapedQuery + ')', 'gi');
        const parts = str.split(regex);
        return parts.map((part) => {
          if (part.toLowerCase() === query.toLowerCase()) {
            return '<mark>' + escapeHtml(part) + '</mark>';
          }
          return escapeHtml(part);
        }).join('');
      }

      function deepCloneData(data) {
        return {
          headers: [...data.headers],
          rows: data.rows.map(r => [...r]),
          totalRows: data.totalRows,
          totalColumns: data.totalColumns,
          delimiter: data.delimiter,
          fileName: data.fileName,
          isStreamMode: data.isStreamMode,
        };
      }

      function updateDirtyUI() {
        const isDirty = modifiedCells.size > 0 || undoStack.length > 0;
        saveBtn.disabled = !isDirty;
        revertBtn.disabled = !isDirty;
        saveBtn.classList.toggle('dirty', isDirty);
        dirtyBadge.classList.toggle('visible', isDirty);
        vscode.postMessage({ type: 'setDirty', isDirty });
      }

      // Filter and sort computation for in-memory mode
      function computeFilteredIndices() {
        if (isStreamMode) return;
        if (!csvData || !csvData.rows) {
          filteredRowIndices = [];
          return;
        }

        const query = searchQuery.trim().toLowerCase();
        const indices = [];

        for (let i = 0; i < csvData.rows.length; i++) {
          if (!query) {
            indices.push(i);
          } else {
            const row = csvData.rows[i];
            const matches = row.some(cell => String(cell || '').toLowerCase().includes(query));
            if (matches) {
              indices.push(i);
            }
          }
        }

        // Apply sorting if active
        if (sortColumn >= 0) {
          const col = sortColumn;
          const isAsc = sortDirection === 'asc';
          indices.sort((a, b) => {
            const valA = String(csvData.rows[a][col] ?? '').trim();
            const valB = String(csvData.rows[b][col] ?? '').trim();

            const numA = Number(valA);
            const numB = Number(valB);
            const bothNumeric = !isNaN(numA) && !isNaN(numB) && valA !== '' && valB !== '';

            let cmp = 0;
            if (bothNumeric) {
              cmp = numA - numB;
            } else {
              cmp = valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
            }
            return isAsc ? cmp : -cmp;
          });
        }

        filteredRowIndices = indices;
      }

      // Fetch page from extension in streaming mode
      function fetchPage(page) {
        if (!isStreamMode || isSearching) return;
        currentPage = page;
        showOverlay('Loading page ' + page + '...', true);
        vscode.postMessage({
          type: 'requestPage',
          page,
          pageSize: pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize,
        });
      }

      // Render Table Header
      function renderHeader() {
        if (!csvData) {
          tableHead.innerHTML = '';
          return;
        }

        const headers = csvData.headers || [];
        let html = '<tr>';
        html += '<th class="row-index">#</th>';

        for (let i = 0; i < headers.length; i++) {
          const title = escapeHtml(headers[i]);
          const letter = getColLetter(i);
          let sortArrow = '';
          if (sortColumn === i) {
            sortArrow = sortDirection === 'asc' ? '&#9650;' : '&#9660;';
          }

          html += '<th data-col="' + i + '" title="Click to sort, double-click to rename">';
          html += '<div class="header-content">';
          html += '<div><span class="col-letter">' + letter + '</span><span class="header-title">' + title + '</span></div>';
          html += '<span class="sort-indicator">' + sortArrow + '</span>';
          html += '</div>';
          html += '</th>';
        }

        html += '</tr>';
        tableHead.innerHTML = html;

        // Header listeners
        const ths = tableHead.querySelectorAll('th[data-col]');
        ths.forEach(th => {
          const col = parseInt(th.getAttribute('data-col'), 10);

          // Click to sort
          th.addEventListener('click', () => {
            if (th.getAttribute('contenteditable') === 'true') return;
            if (sortColumn === col) {
              if (sortDirection === 'asc') {
                sortDirection = 'desc';
              } else {
                sortColumn = -1; // reset to natural
                sortDirection = 'asc';
              }
            } else {
              sortColumn = col;
              sortDirection = 'asc';
            }

            if (isStreamMode) {
              // In stream mode, sort currently loaded rows or search matches
              const rowsToSort = isSearching ? searchMatches : csvData.rows;
              const isAsc = sortDirection === 'asc';
              if (sortColumn >= 0) {
                rowsToSort.sort((a, b) => {
                  const valA = String((isSearching ? a.row[col] : a[col]) ?? '').trim();
                  const valB = String((isSearching ? b.row[col] : b[col]) ?? '').trim();
                  const numA = Number(valA);
                  const numB = Number(valB);
                  const bothNum = !isNaN(numA) && !isNaN(numB) && valA !== '' && valB !== '';
                  let cmp = bothNum ? numA - numB : valA.localeCompare(valB, undefined, { numeric: true, sensitivity: 'base' });
                  return isAsc ? cmp : -cmp;
                });
              }
              renderHeader();
              renderBody();
            } else {
              currentPage = 1;
              computeFilteredIndices();
              renderHeader();
              renderBody();
              updatePagination();
            }
          });

          // Double click to rename header
          th.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            const titleSpan = th.querySelector('.header-title');
            if (!titleSpan) return;
            titleSpan.contentEditable = 'true';
            titleSpan.focus();
            selectAllText(titleSpan);

            function commitTitle() {
              titleSpan.contentEditable = 'false';
              const newTitle = titleSpan.innerText.trim() || ('Column ' + (col + 1));
              const oldTitle = csvData.headers[col] || '';
              if (newTitle !== oldTitle) {
                undoStack.push({ type: 'header', col, oldVal: oldTitle, newVal: newTitle });
                csvData.headers[col] = newTitle;
                updateDirtyUI();
              }
              renderHeader();
            }

            titleSpan.addEventListener('keydown', (ev) => {
              if (ev.key === 'Enter') {
                ev.preventDefault();
                commitTitle();
              } else if (ev.key === 'Escape') {
                ev.preventDefault();
                titleSpan.contentEditable = 'false';
                renderHeader();
              }
            });
            titleSpan.addEventListener('blur', commitTitle, { once: true });
          });
        });
      }

      // Render Table Body
      function renderBody() {
        if (!csvData) {
          tableBody.innerHTML = '';
          return;
        }

        hideOverlay();
        const query = searchQuery.trim();
        let rowsHtml = '';

        if (isStreamMode && isSearching) {
          // Render streaming search matches
          if (searchMatches.length === 0) {
            tableBody.innerHTML = '';
            showOverlay('No rows match your search query.');
            delRowBtn.disabled = true;
            return;
          }

          const total = searchMatches.length;
          const effPageSize = pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize;
          const start = (currentPage - 1) * effPageSize;
          const end = Math.min(start + effPageSize, total);

          for (let i = start; i < end; i++) {
            const item = searchMatches[i];
            const rawRow = item.rowNumber;
            const displayRowNum = rawRow + 1;
            const rowData = item.row;

            rowsHtml += '<tr data-raw-row="' + rawRow + '">';
            rowsHtml += '<td class="row-index">' + displayRowNum + '</td>';

            for (let c = 0; c < rowData.length; c++) {
              const cellVal = rowData[c] ?? '';
              const isModified = modifiedCells.has(rawRow + ':' + c);
              const isSelected = selectedRawRow === rawRow && selectedCol === c;
              const highlighted = highlightText(cellVal, query);

              let classes = [];
              if (isModified) classes.push('cell-modified');
              if (isSelected) classes.push('selected');
              const classAttr = classes.length > 0 ? ' class="' + classes.join(' ') + '"' : '';

              rowsHtml += '<td' + classAttr + ' data-raw-row="' + rawRow + '" data-col="' + c + '" title="' + escapeHtml(cellVal) + '">' + highlighted + '</td>';
            }
            rowsHtml += '</tr>';
          }
        } else if (isStreamMode) {
          // Render dynamically fetched page
          const rows = csvData.rows || [];
          if (rows.length === 0) {
            tableBody.innerHTML = '';
            showOverlay('This file is empty.');
            delRowBtn.disabled = true;
            return;
          }

          const effPageSize = pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize;
          const count = pageSize === -1 ? Math.min(MAX_ALL_PAGE_SIZE, rows.length) : Math.min(effPageSize, rows.length);
          const baseIndex = (currentPage - 1) * effPageSize;

          for (let i = 0; i < count; i++) {
            const rawRow = baseIndex + i;
            const displayRowNum = rawRow + 1;
            const rowData = rows[i];

            rowsHtml += '<tr data-raw-row="' + rawRow + '">';
            rowsHtml += '<td class="row-index">' + displayRowNum + '</td>';

            for (let c = 0; c < rowData.length; c++) {
              const cellVal = rowData[c] ?? '';
              const isModified = modifiedCells.has(rawRow + ':' + c);
              const isSelected = selectedRawRow === rawRow && selectedCol === c;

              let classes = [];
              if (isModified) classes.push('cell-modified');
              if (isSelected) classes.push('selected');
              const classAttr = classes.length > 0 ? ' class="' + classes.join(' ') + '"' : '';

              rowsHtml += '<td' + classAttr + ' data-raw-row="' + rawRow + '" data-col="' + c + '" title="' + escapeHtml(cellVal) + '">' + escapeHtml(cellVal) + '</td>';
            }
            rowsHtml += '</tr>';
          }
        } else {
          // In-memory mode
          if (filteredRowIndices.length === 0) {
            tableBody.innerHTML = '';
            if (csvData.rows.length === 0) {
              showOverlay('This file is empty.');
            } else {
              showOverlay('No rows match your search query.');
            }
            delRowBtn.disabled = true;
            return;
          }

          const totalFiltered = filteredRowIndices.length;
          const effPageSize = pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize;
          const start = (currentPage - 1) * effPageSize;
          const end = Math.min(start + effPageSize, totalFiltered);

          for (let idx = start; idx < end; idx++) {
            const rawRowIndex = filteredRowIndices[idx];
            const rowData = csvData.rows[rawRowIndex];
            const displayRowNum = rawRowIndex + 1;

            rowsHtml += '<tr data-raw-row="' + rawRowIndex + '">';
            rowsHtml += '<td class="row-index">' + displayRowNum + '</td>';

            for (let c = 0; c < rowData.length; c++) {
              const cellVal = rowData[c] ?? '';
              const isModified = modifiedCells.has(rawRowIndex + ':' + c);
              const isSelected = selectedRawRow === rawRowIndex && selectedCol === c;
              const highlighted = highlightText(cellVal, query);

              let classes = [];
              if (isModified) classes.push('cell-modified');
              if (isSelected) classes.push('selected');
              const classAttr = classes.length > 0 ? ' class="' + classes.join(' ') + '"' : '';

              rowsHtml += '<td' + classAttr + ' data-raw-row="' + rawRowIndex + '" data-col="' + c + '" title="' + escapeHtml(cellVal) + '">' + highlighted + '</td>';
            }
            rowsHtml += '</tr>';
          }
        }

        tableBody.innerHTML = rowsHtml;
      }

      // Helper to select all text in contenteditable
      function selectAllText(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }

      function placeCaretAtEnd(el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }

      // Start In-Place Cell Edit via contenteditable
      function startCellEdit(td, rawRow, col, replaceChar = null) {
        if (activeEditingTd && activeEditingTd !== td) {
          commitCellEdit(activeEditingTd);
        }

        activeEditingTd = td;
        const currentVal = getCellValue(rawRow, col);
        activeEditingInitialValue = currentVal;

        td.classList.add('editing');
        td.contentEditable = 'true';

        if (replaceChar !== null) {
          td.textContent = replaceChar;
          placeCaretAtEnd(td);
        } else {
          td.textContent = activeEditingInitialValue;
          selectAllText(td);
        }
        td.focus();

        function onKeyDown(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            commitCellEdit(td);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancelCellEdit(td);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            commitCellEdit(td);
            if (e.shiftKey) {
              moveEditPrev(rawRow, col);
            } else {
              moveEditNext(rawRow, col);
            }
          }
        }

        function onBlur() {
          if (activeEditingTd === td) {
            commitCellEdit(td);
          }
          td.removeEventListener('keydown', onKeyDown);
          td.removeEventListener('blur', onBlur);
        }

        td.addEventListener('keydown', onKeyDown);
        td.addEventListener('blur', onBlur);
      }

      function getCellValue(rawRow, col) {
        if (isStreamMode) {
          if (modifiedRows.has(rawRow)) {
            return modifiedRows.get(rawRow)[col] ?? '';
          }
          if (isSearching) {
            const item = searchMatches.find(m => m.rowNumber === rawRow);
            return item ? (item.row[col] ?? '') : '';
          }
          const effPageSize = pageSize === -1 ? csvData.rows.length : pageSize;
          const relIndex = rawRow - (currentPage - 1) * effPageSize;
          return csvData.rows[relIndex]?.[col] ?? '';
        }
        return csvData.rows[rawRow]?.[col] ?? '';
      }

      function setCellValue(rawRow, col, newValue) {
        if (isStreamMode) {
          let rowData = null;
          if (modifiedRows.has(rawRow)) {
            rowData = modifiedRows.get(rawRow);
          } else if (isSearching) {
            const item = searchMatches.find(m => m.rowNumber === rawRow);
            if (item) rowData = [...item.row];
          } else {
            const effPageSize = pageSize === -1 ? csvData.rows.length : pageSize;
            const relIndex = rawRow - (currentPage - 1) * effPageSize;
            if (csvData.rows[relIndex]) {
              rowData = [...csvData.rows[relIndex]];
            }
          }

          if (rowData) {
            rowData[col] = newValue;
            modifiedRows.set(rawRow, rowData);
            if (isSearching) {
              const item = searchMatches.find(m => m.rowNumber === rawRow);
              if (item) item.row[col] = newValue;
            } else {
              const effPageSize = pageSize === -1 ? csvData.rows.length : pageSize;
              const relIndex = rawRow - (currentPage - 1) * effPageSize;
              if (csvData.rows[relIndex]) {
                csvData.rows[relIndex][col] = newValue;
              }
            }
          }
        } else {
          csvData.rows[rawRow][col] = newValue;
        }
      }

      function commitCellEdit(td) {
        if (!td) return;
        const rawRow = parseInt(td.getAttribute('data-raw-row'), 10);
        const col = parseInt(td.getAttribute('data-col'), 10);
        const newValue = td.innerText.replace(/\\r?\\n$/, '');
        const oldValue = activeEditingInitialValue;

        td.contentEditable = 'false';
        td.classList.remove('editing');
        activeEditingTd = null;

        if (newValue !== oldValue) {
          undoStack.push({ type: 'cell', rawRow, col, oldVal: oldValue, newVal: newValue });
          redoStack = [];
          setCellValue(rawRow, col, newValue);
          modifiedCells.add(rawRow + ':' + col);
          updateDirtyUI();
        }

        td.textContent = newValue;
        td.setAttribute('title', newValue);
        if (modifiedCells.has(rawRow + ':' + col)) {
          td.classList.add('cell-modified');
        }

        // Sync with top cell bar
        if (selectedRawRow === rawRow && selectedCol === col) {
          cellBarInput.value = newValue;
        }
      }

      function cancelCellEdit(td) {
        if (!td) return;
        td.contentEditable = 'false';
        td.classList.remove('editing');
        td.textContent = activeEditingInitialValue;
        td.setAttribute('title', activeEditingInitialValue);
        activeEditingTd = null;
      }

      function moveEditNext(rawRow, col) {
        const nextCol = col + 1;
        if (nextCol < csvData.headers.length) {
          const targetTd = tableBody.querySelector('td[data-raw-row="' + rawRow + '"][data-col="' + nextCol + '"]');
          if (targetTd) {
            selectCell(rawRow, nextCol, targetTd);
            startCellEdit(targetTd, rawRow, nextCol);
          }
        }
      }

      function moveEditPrev(rawRow, col) {
        const prevCol = col - 1;
        if (prevCol >= 0) {
          const targetTd = tableBody.querySelector('td[data-raw-row="' + rawRow + '"][data-col="' + prevCol + '"]');
          if (targetTd) {
            selectCell(rawRow, prevCol, targetTd);
            startCellEdit(targetTd, rawRow, prevCol);
          }
        }
      }

      function selectCell(rawRow, col, td) {
        const prevSelected = tableBody.querySelector('td.selected');
        if (prevSelected) prevSelected.classList.remove('selected');

        selectedRawRow = rawRow;
        selectedCol = col;
        delRowBtn.disabled = isStreamMode; // Row deletion on multi-million row stream disabled for safety

        const val = getCellValue(rawRow, col);
        const colLetter = getColLetter(col);
        const colName = csvData?.headers[col] || ('Col ' + (col + 1));
        const address = colLetter + (rawRow + 1);

        cellAddressBadge.textContent = address;
        cellBarInput.value = val;
        cellBarInput.disabled = false;

        if (td) {
          td.classList.add('selected');
        }
        cellInfo.textContent = 'Selected ' + address + ' (' + colName + ')';
      }

      // Top Cell Bar input handler
      cellBarInput.addEventListener('input', () => {
        if (selectedRawRow < 0 || selectedCol < 0 || !csvData) return;
        const rawRow = selectedRawRow;
        const col = selectedCol;
        const newVal = cellBarInput.value;
        const oldVal = getCellValue(rawRow, col);

        if (newVal !== oldVal) {
          setCellValue(rawRow, col, newVal);
          modifiedCells.add(rawRow + ':' + col);
          updateDirtyUI();

          const td = tableBody.querySelector('td[data-raw-row="' + rawRow + '"][data-col="' + col + '"]');
          if (td) {
            td.textContent = newVal;
            td.setAttribute('title', newVal);
            td.classList.add('cell-modified');
          }
        }
      });

      cellBarInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          cellBarInput.blur();
          tableContainer.focus();
        }
      });

      // Add Row (In-memory mode only)
      addRowBtn.addEventListener('click', () => {
        if (!csvData) return;
        if (isStreamMode) {
          vscode.postMessage({ type: 'showInfo', message: 'Adding rows is only supported for files under 5MB.' });
          return;
        }

        const newRow = new Array(csvData.headers.length).fill('');
        const insertIndex = selectedRawRow >= 0 ? selectedRawRow + 1 : csvData.rows.length;
        csvData.rows.splice(insertIndex, 0, newRow);
        csvData.totalRows = csvData.rows.length;

        undoStack.push({ type: 'addRow', index: insertIndex, row: newRow });
        redoStack = [];
        for (let c = 0; c < csvData.headers.length; c++) {
          modifiedCells.add(insertIndex + ':' + c);
        }
        updateDirtyUI();

        computeFilteredIndices();
        renderBody();
        updatePagination();

        setTimeout(() => {
          const newTd = tableBody.querySelector('td[data-raw-row="' + insertIndex + '"][data-col="0"]');
          if (newTd) {
            selectCell(insertIndex, 0, newTd);
            startCellEdit(newTd, insertIndex, 0);
          }
        }, 50);
      });

      // Delete Row
      delRowBtn.addEventListener('click', () => {
        if (!csvData || selectedRawRow < 0 || isStreamMode) return;
        const rowIdx = selectedRawRow;
        const deletedRow = csvData.rows[rowIdx];

        csvData.rows.splice(rowIdx, 1);
        csvData.totalRows = csvData.rows.length;

        undoStack.push({ type: 'delRow', index: rowIdx, row: deletedRow });
        redoStack = [];
        updateDirtyUI();

        selectedRawRow = -1;
        selectedCol = -1;
        delRowBtn.disabled = true;
        cellAddressBadge.textContent = '-';
        cellBarInput.value = '';
        cellBarInput.disabled = true;

        computeFilteredIndices();
        renderBody();
        updatePagination();
      });

      // Add Column
      addColBtn.addEventListener('click', () => {
        if (!csvData) return;
        const newColIdx = csvData.headers.length;
        const newColName = 'Column ' + (newColIdx + 1);

        csvData.headers.push(newColName);
        if (!isStreamMode) {
          for (let r = 0; r < csvData.rows.length; r++) {
            csvData.rows[r].push('');
          }
        }
        csvData.totalColumns = csvData.headers.length;

        undoStack.push({ type: 'addCol', index: newColIdx, name: newColName });
        redoStack = [];
        updateDirtyUI();

        renderHeader();
        renderBody();
        updatePagination();
      });

      // Save Changes
      saveBtn.addEventListener('click', () => {
        if (activeEditingTd) {
          commitCellEdit(activeEditingTd);
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        if (isStreamMode) {
          const modObj = {};
          modifiedRows.forEach((val, key) => {
            modObj[key] = val;
          });
          vscode.postMessage({
            type: 'saveDelta',
            headers: csvData.headers,
            modifiedRows: modObj,
            delimiter: delimiterSelect.value === 'auto' ? csvData.delimiter : delimiterSelect.value,
            hasHeader: headerCheckbox.checked,
          });
        } else {
          vscode.postMessage({
            type: 'saveData',
            headers: csvData.headers,
            rows: csvData.rows,
            delimiter: delimiterSelect.value === 'auto' ? csvData.delimiter : delimiterSelect.value,
            hasHeader: headerCheckbox.checked,
          });
        }
      });

      // Revert Changes
      revertBtn.addEventListener('click', () => {
        if (!initialSnapshot) return;
        csvData = deepCloneData(initialSnapshot);
        modifiedCells.clear();
        modifiedRows.clear();
        undoStack = [];
        redoStack = [];
        activeEditingTd = null;
        updateDirtyUI();
        if (isStreamMode) {
          fetchPage(currentPage);
        } else {
          computeFilteredIndices();
          renderHeader();
          renderBody();
          updatePagination();
        }
      });

      // Global keyboard shortcuts (Ctrl+S, Ctrl+Z, Ctrl+Y, Enter, typing)
      window.addEventListener('keydown', (e) => {
        // Ctrl+S / Cmd+S: Save
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          if (!saveBtn.disabled) {
            saveBtn.click();
          }
          return;
        }

        // Ignore hotkeys when typing in top inputs
        if (document.activeElement === searchInput || document.activeElement === cellBarInput) {
          return;
        }

        // Ctrl+Z: Undo
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
          if (!activeEditingTd && undoStack.length > 0) {
            e.preventDefault();
            performUndo();
          }
          return;
        }

        // Ctrl+Y or Ctrl+Shift+Z: Redo
        if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
            ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')) {
          if (!activeEditingTd && redoStack.length > 0) {
            e.preventDefault();
            performRedo();
          }
          return;
        }

        // Enter or F2 to start editing selected cell
        if ((e.key === 'Enter' || e.key === 'F2') && selectedRawRow >= 0 && selectedCol >= 0 && !activeEditingTd) {
          const td = tableBody.querySelector('td[data-raw-row="' + selectedRawRow + '"][data-col="' + selectedCol + '"]');
          if (td) {
            e.preventDefault();
            startCellEdit(td, selectedRawRow, selectedCol);
          }
          return;
        }

        // Typing character directly onto selected cell starts edit with that char
        if (!activeEditingTd && selectedRawRow >= 0 && selectedCol >= 0 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const td = tableBody.querySelector('td[data-raw-row="' + selectedRawRow + '"][data-col="' + selectedCol + '"]');
          if (td) {
            e.preventDefault();
            startCellEdit(td, selectedRawRow, selectedCol, e.key);
          }
          return;
        }
      });

      function performUndo() {
        const action = undoStack.pop();
        if (!action) return;

        if (action.type === 'cell') {
          redoStack.push(action);
          setCellValue(action.rawRow, action.col, action.oldVal);
          renderBody();
        } else if (action.type === 'addRow') {
          redoStack.push(action);
          csvData.rows.splice(action.index, 1);
          csvData.totalRows = csvData.rows.length;
          computeFilteredIndices();
          renderBody();
          updatePagination();
        } else if (action.type === 'delRow') {
          redoStack.push(action);
          csvData.rows.splice(action.index, 0, action.row);
          csvData.totalRows = csvData.rows.length;
          computeFilteredIndices();
          renderBody();
          updatePagination();
        }
        updateDirtyUI();
      }

      function performRedo() {
        const action = redoStack.pop();
        if (!action) return;

        if (action.type === 'cell') {
          undoStack.push(action);
          setCellValue(action.rawRow, action.col, action.newVal);
          renderBody();
        } else if (action.type === 'addRow') {
          undoStack.push(action);
          csvData.rows.splice(action.index, 0, action.row);
          csvData.totalRows = csvData.rows.length;
          computeFilteredIndices();
          renderBody();
          updatePagination();
        }
        updateDirtyUI();
      }

      // Cell selection and double click to edit
      tableBody.addEventListener('click', (e) => {
        const td = e.target.closest('td');
        if (!td || td.classList.contains('row-index') || td.classList.contains('editing')) return;

        const rawRow = parseInt(td.getAttribute('data-raw-row'), 10);
        const col = parseInt(td.getAttribute('data-col'), 10);
        selectCell(rawRow, col, td);
      });

      tableBody.addEventListener('dblclick', (e) => {
        const td = e.target.closest('td');
        if (!td || td.classList.contains('row-index')) return;

        const rawRow = parseInt(td.getAttribute('data-raw-row'), 10);
        const col = parseInt(td.getAttribute('data-col'), 10);
        selectCell(rawRow, col, td);
        startCellEdit(td, rawRow, col);
      });

      function updatePagination() {
        if (!csvData) {
          pageInfo.textContent = 'Page 0 of 0';
          statsLabel.textContent = '';
          return;
        }

        let totalRecords = csvData.totalRows;
        let maxPage = 1;
        const effPageSize = pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize;

        if (isStreamMode && isSearching) {
          totalRecords = searchMatches.length;
          maxPage = Math.max(1, Math.ceil(totalRecords / effPageSize));
        } else if (isStreamMode) {
          maxPage = Math.max(1, Math.ceil(totalRecords / effPageSize));
        } else {
          const totalFiltered = filteredRowIndices.length;
          maxPage = Math.max(1, Math.ceil(totalFiltered / effPageSize));
        }

        if (currentPage > maxPage) currentPage = maxPage;
        if (currentPage < 1) currentPage = 1;

        pageInfo.textContent = 'Page ' + currentPage + ' of ' + maxPage;
        firstPageBtn.disabled = currentPage <= 1;
        prevPageBtn.disabled = currentPage <= 1;
        nextPageBtn.disabled = currentPage >= maxPage;
        lastPageBtn.disabled = currentPage >= maxPage;

        let stats = totalRecords.toLocaleString() + ' rows &times; ' + csvData.totalColumns + ' cols';
        if (isStreamMode && isIndexing) {
          stats += ' (Indexing...)';
        }
        if (isStreamMode && isSearching) {
          stats += ' (Filtered: ' + searchMatches.length.toLocaleString() + ' matches)';
        } else if (!isStreamMode && searchQuery.trim().length > 0) {
          stats += ' (Filtered: ' + filteredRowIndices.length.toLocaleString() + ' of ' + csvData.totalRows.toLocaleString() + ')';
        }
        statsLabel.innerHTML = stats;
      }

      function showOverlay(message, isSpinner = false) {
        statusMessage.textContent = message;
        const spinner = statusOverlay.querySelector('.spinner');
        if (spinner) spinner.style.display = isSpinner ? 'block' : 'none';
        statusOverlay.classList.remove('hidden');
      }

      function hideOverlay() {
        statusOverlay.classList.add('hidden');
      }

      // Search & Filter input with streaming debounce
      searchInput.addEventListener('input', () => {
        searchQuery = searchInput.value;
        searchClear.style.display = searchQuery ? 'block' : 'none';

        if (isStreamMode) {
          if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
          searchDebounceTimer = setTimeout(() => {
            const query = searchInput.value.trim();
            if (!query) {
              isSearching = false;
              searchMatches = [];
              searchIndicator.style.display = 'none';
              vscode.postMessage({ type: 'cancelSearch', sessionId: searchSessionId });
              currentPage = 1;
              fetchPage(1);
            } else {
              isSearching = true;
              searchMatches = [];
              currentPage = 1;
              searchSessionId = Date.now().toString();
              searchIndicator.style.display = 'inline-flex';
              searchProgressText.textContent = 'Scanning stream...';
              renderBody();
              updatePagination();
              vscode.postMessage({ type: 'startSearch', query, sessionId: searchSessionId });
            }
          }, 250);
        } else {
          currentPage = 1;
          computeFilteredIndices();
          renderBody();
          updatePagination();
        }
      });

      searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchQuery = '';
        searchClear.style.display = 'none';

        if (isStreamMode) {
          isSearching = false;
          searchMatches = [];
          searchIndicator.style.display = 'none';
          vscode.postMessage({ type: 'cancelSearch', sessionId: searchSessionId });
          currentPage = 1;
          fetchPage(1);
        } else {
          currentPage = 1;
          computeFilteredIndices();
          renderBody();
          updatePagination();
        }
        searchInput.focus();
      });

      headerCheckbox.addEventListener('change', () => {
        showOverlay('Re-parsing...', true);
        vscode.postMessage({
          type: 'requestReload',
          hasHeader: headerCheckbox.checked,
        });
      });

      delimiterSelect.addEventListener('change', () => {
        showOverlay('Re-parsing...', true);
        vscode.postMessage({
          type: 'requestReload',
          delimiter: delimiterSelect.value,
        });
      });

      pageSizeSelect.addEventListener('change', () => {
        pageSize = parseInt(pageSizeSelect.value, 10);
        currentPage = 1;
        if (isStreamMode && !isSearching) {
          fetchPage(1);
        } else {
          renderBody();
          updatePagination();
        }
        tableContainer.scrollTop = 0;
      });

      firstPageBtn.addEventListener('click', () => {
        if (currentPage > 1) {
          if (isStreamMode && !isSearching) {
            fetchPage(1);
          } else {
            currentPage = 1;
            renderBody();
            updatePagination();
          }
          tableContainer.scrollTop = 0;
        }
      });

      prevPageBtn.addEventListener('click', () => {
        if (currentPage > 1) {
          if (isStreamMode && !isSearching) {
            fetchPage(currentPage - 1);
          } else {
            currentPage--;
            renderBody();
            updatePagination();
          }
          tableContainer.scrollTop = 0;
        }
      });

      nextPageBtn.addEventListener('click', () => {
        const effPageSize = pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize;
        const total = isStreamMode ? (isSearching ? searchMatches.length : csvData.totalRows) : filteredRowIndices.length;
        const maxPage = Math.max(1, Math.ceil(total / effPageSize));

        if (currentPage < maxPage) {
          if (isStreamMode && !isSearching) {
            fetchPage(currentPage + 1);
          } else {
            currentPage++;
            renderBody();
            updatePagination();
          }
          tableContainer.scrollTop = 0;
        }
      });

      lastPageBtn.addEventListener('click', () => {
        const effPageSize = pageSize === -1 ? MAX_ALL_PAGE_SIZE : pageSize;
        const total = isStreamMode ? (isSearching ? searchMatches.length : csvData.totalRows) : filteredRowIndices.length;
        const maxPage = Math.max(1, Math.ceil(total / effPageSize));

        if (currentPage < maxPage) {
          if (isStreamMode && !isSearching) {
            fetchPage(maxPage);
          } else {
            currentPage = maxPage;
            renderBody();
            updatePagination();
          }
          tableContainer.scrollTop = 0;
        }
      });

      // Copy buttons
      copyMdBtn.addEventListener('click', () => {
        if (!csvData) return;
        let rowsToExport = [];
        if (isStreamMode && isSearching) {
          rowsToExport = searchMatches.map(m => m.row);
        } else if (isStreamMode) {
          rowsToExport = csvData.rows;
        } else {
          rowsToExport = filteredRowIndices.map(idx => csvData.rows[idx]);
        }
        const md = generateMarkdown(csvData.headers, rowsToExport);
        vscode.postMessage({
          type: 'copyToClipboard',
          text: md,
          format: 'markdown',
        });
      });

      copyTsvBtn.addEventListener('click', () => {
        if (!csvData) return;
        let rowsToExport = [];
        if (isStreamMode && isSearching) {
          rowsToExport = searchMatches.map(m => m.row);
        } else if (isStreamMode) {
          rowsToExport = csvData.rows;
        } else {
          rowsToExport = filteredRowIndices.map(idx => csvData.rows[idx]);
        }
        const tsv = generateTsv(csvData.headers, rowsToExport);
        vscode.postMessage({
          type: 'copyToClipboard',
          text: tsv,
          format: 'tsv',
        });
      });

      function generateMarkdown(headers, rows) {
        const escapeCell = str => (str || '').replace(/\\|/g, '\\\\|').replace(/\\r?\\n/g, ' ');
        const hLine = '| ' + headers.map(escapeCell).join(' | ') + ' |';
        const sLine = '| ' + headers.map(() => '---').join(' | ') + ' |';
        const dLines = rows.map(r => '| ' + headers.map((_, i) => escapeCell(r[i] ?? '')).join(' | ') + ' |');
        return [hLine, sLine, ...dLines].join('\\n');
      }

      function generateTsv(headers, rows) {
        const escapeCell = val => {
          const t = String(val ?? '');
          if (t.includes('\\t') || t.includes('\\n') || t.includes('"')) {
            return '"' + t.replace(/"/g, '""') + '"';
          }
          return t;
        };
        const lines = [];
        if (headers.length > 0) lines.push(headers.map(escapeCell).join('\\t'));
        for (const row of rows) {
          lines.push(headers.map((_, i) => escapeCell(row[i] ?? '')).join('\\t'));
        }
        return lines.join('\\n');
      }

      // Handle messages from VS Code extension
      window.addEventListener('message', (event) => {
        const message = event.data;
        switch (message.type) {
          case 'init':
          case 'update': {
            csvData = message.data;
            isStreamMode = !!message.data.isStreamMode;
            isIndexing = !!message.data.isIndexing;

            initialSnapshot = deepCloneData(csvData);
            modifiedCells.clear();
            modifiedRows.clear();
            undoStack = [];
            redoStack = [];
            activeEditingTd = null;
            selectedRawRow = -1;
            selectedCol = -1;
            cellAddressBadge.textContent = '-';
            cellBarInput.value = '';
            cellBarInput.disabled = true;
            updateDirtyUI();

            if (!isStreamMode) {
              computeFilteredIndices();
            }
            renderHeader();
            renderBody();
            updatePagination();
            break;
          }

          case 'pageData': {
            hideOverlay();
            csvData.rows = message.rows;
            if (message.totalRows !== undefined) {
              csvData.totalRows = message.totalRows;
            }
            currentPage = message.page;
            renderBody();
            updatePagination();
            break;
          }

          case 'searchBatch': {
            if (message.sessionId !== searchSessionId) break;
            searchMatches.push(...message.matches);

            if (message.done) {
              searchProgressText.textContent = searchMatches.length.toLocaleString() + ' matches';
              setTimeout(() => {
                if (isSearching) {
                  searchIndicator.style.opacity = '0.7';
                }
              }, 2000);
            } else {
              const pct = Math.round(message.scannedRatio * 100);
              searchProgressText.textContent = pct + '% (' + searchMatches.length.toLocaleString() + ' matches)';
            }

            renderBody();
            updatePagination();
            break;
          }

          case 'indexProgress': {
            if (csvData && isStreamMode) {
              csvData.totalRows = message.totalRows;
              isIndexing = !message.isComplete;
              updatePagination();
            }
            break;
          }

          case 'saveSuccess': {
            initialSnapshot = deepCloneData(csvData);
            modifiedCells.clear();
            modifiedRows.clear();
            undoStack = [];
            redoStack = [];
            saveBtn.textContent = '💾 Save';
            updateDirtyUI();
            renderBody();
            break;
          }

          case 'saveError': {
            saveBtn.textContent = '💾 Save';
            saveBtn.disabled = false;
            break;
          }

          case 'error': {
            showOverlay(message.message, false);
            break;
          }
        }
      });

      // Signal ready to host
      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
  }
}
