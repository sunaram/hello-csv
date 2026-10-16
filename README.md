# Hello CSV (VS Code Extension)

[![Visual Studio Marketplace](https://img.shields.io/badge/Visual%20Studio%20Marketplace-Hello%20CSV-blue?logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=sunaram.hellocsv)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-0.3.1-green.svg)](package.json)
[![GitHub Repository](https://img.shields.io/badge/GitHub-sunaram%2Fhello--csv-blue?logo=github)](https://github.com/sunaram/hello-csv)

A fast, interactive, and theme-aware **CSV & TSV tabular viewer and in-place editor** for Visual Studio Code.

---

## 🌟 Features

### 1. Blazing-Fast Virtual Streaming (Millions of Rows)
- **Instant First Paint (< 50ms)**: Reads and parses the initial preview chunk in milliseconds so you can start viewing massive files immediately.
- **Sparse Byte-Offset Indexing**: Streams the file in the background to build a lightweight byte map, enabling sub-5ms random-access seeks across millions of rows.
- **Real-Time Streaming Search**: Raw-string pre-filtering scans files at disk speed without full CSV parsing overhead, streaming live matching batches straight into the table.
- **Debounced Input with Auto-Cancel**: Keystrokes instantly cancel previous search streams via `AbortController`, eliminating lag or backlog.
- **Atomic Delta Saving**: Saves edited cells on multi-gigabyte files using a streaming pipeline with constant low memory (<10MB RAM).

### 2. In-Place Cell Editing & Spreadsheet Controls
- **Direct Cell Editing**: Double-click any cell, or select it and press <kbd>Enter</kbd> or <kbd>F2</kbd> to edit inline.
- **Direct Typing**: Click any cell once and start typing to immediately replace its content and begin editing (just like Excel and Google Sheets).
- **Top Formula / Value Bar**: An Excel-style address and value bar (`A1`, `B4`...) right under the toolbar for viewing and editing long text or URLs with live two-way sync.
- **Save to Disk**: Press <kbd>Ctrl</kbd> + <kbd>S</kbd> (<kbd>Cmd</kbd> + <kbd>S</kbd>) or click **"💾 Save"** to write changes back to the CSV file with full RFC 4180 escaping (preserving delimiters, internal quotes, and newlines).
- **Visual Change Tracking**: Modified cells display a subtle amber corner marker and the editor tab displays an unsaved indicator (`●`).
- **Undo / Redo & Revert**: Full <kbd>Ctrl</kbd> + <kbd>Z</kbd> undo, <kbd>Ctrl</kbd> + <kbd>Y</kbd> redo, and a **"↩ Revert"** button to discard unsaved edits.
- **Table Operations**:
  - `+ Row`: Append a new row or insert below the selected row.
  - `- Row`: Delete the selected row.
  - `+ Col`: Add a new column to the table.
  - Double-click any column header to rename it.

### 3. Tabular Exploration & Navigation
- **Sticky Headers & Row Counter**: Headers and the 1-based row counter stay fixed during vertical and horizontal scrolling.
- **Instant Search & Filter**: Real-time multi-column search with match highlighting and filtered row counts.
- **Click-to-Sort**: Click any column header to cycle between Ascending, Descending, and Natural order (supports both numeric and string values).
- **Fast Pagination**: Smooth 60fps performance even on large datasets. Select between `25`, `50`, `100`, `250`, or `All` rows per page.
- **Delimiter Auto-Detection & Selector**: Automatic detection or manual override for Comma (`,`), Semicolon (`;`), Tab (`\t`), and Pipe (`|`).
- **Toggle Header Row**: Treat the first row as column titles or view generic column letters (`A`, `B`, `C`...).
- **Clipboard Export**: One-click **Copy MD** (Markdown table) or **Copy TSV** (ready to paste directly into Excel or Google Sheets).
- **Auto-Sync on Save**: Editing the CSV file externally or in a split text editor automatically updates the table preview when clean.
- **Native VS Code Theming**: Automatically matches your current VS Code theme (Dark+, Light+, High Contrast, and community themes).

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| --- | --- |
| <kbd>Double-Click</kbd> / <kbd>Enter</kbd> / <kbd>F2</kbd> | Edit selected cell in-place |
| Any printable character (<kbd>A-Z</kbd>, <kbd>0-9</kbd>) | Start editing selected cell with typed character |
| <kbd>Enter</kbd> (while editing) | Commit cell edit and move down to next row |
| <kbd>Tab</kbd> / <kbd>Shift</kbd> + <kbd>Tab</kbd> | Commit edit and edit next / previous cell |
| <kbd>Escape</kbd> | Cancel in-place cell edit |
| <kbd>Ctrl</kbd> + <kbd>S</kbd> / <kbd>Cmd</kbd> + <kbd>S</kbd> | Save changes to CSV file |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> / <kbd>Cmd</kbd> + <kbd>Z</kbd> | Undo cell edit or row operation |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> / <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> | Redo cell edit or row operation |

---

## 🚀 How to Use

1. **Explorer Context Menu**: Right-click any `.csv`, `.tsv`, `.tab`, or `.txt` file in VS Code's File Explorer and select **"Preview with Hello CSV"**.
2. **Editor Context Menu**: Right-click inside an open CSV file and select **"Preview with Hello CSV"**.
3. **Editor Tab Bar**: Click the table icon (`$(table)`) in the editor tab bar when viewing a CSV.
4. **Command Palette**: Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> (or <kbd>Cmd</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>) and type:
   ```
   Hello CSV: Preview with Hello CSV
   ```

---

## 📦 Publishing to VS Code Marketplace

### Prerequisites
1. An [Azure DevOps](https://dev.azure.com/) account.
2. A Personal Access Token (PAT) with `Marketplace (Manage)` permissions.
3. A publisher created on the [VS Code Marketplace Management Portal](https://marketplace.visualstudio.com/manage).

### Packaging the Extension
```bash
# Build the production bundle
npm run build

# Package into a .vsix file
npx @vscode/vsce package --no-dependencies
```

### Publishing via CLI
```bash
# Log in with your publisher ID and Personal Access Token
npx @vscode/vsce login <publisher-name>

# Publish directly to the Visual Studio Code Marketplace
npx @vscode/vsce publish
```

*Alternatively, upload the generated `hellocsv-0.2.0.vsix` directly on the [Marketplace Manage Page](https://marketplace.visualstudio.com/manage).*

---

## 🧪 Development & Testing

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Run build
npm run build

# Watch mode during development
npm run watch
```

To run and debug the extension:
1. Open the project in VS Code.
2. Press <kbd>F5</kbd> to launch the **Extension Development Host**.

---

## 📄 License

This extension is licensed under the [MIT License](LICENSE).
