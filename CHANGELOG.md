# Change Log

All notable changes to the "Hello CSV" extension will be documented in this file.

## [0.2.0] - 2026-10-15

### Added
- **Full In-Place Cell Editing**: Double-click any cell or press Enter/F2 to edit directly inside the table.
- **Top Formula / Cell Value Bar**: Excel-style cell address and value editor bar with live two-way sync to the table.
- **Direct Typing**: Click any cell and start typing letters/numbers to immediately replace content and begin editing.
- **Table Operations**:
  - `+ Row`: Append a new blank row.
  - `- Row`: Delete selected row.
  - `+ Col`: Add a new column.
  - Double-click column header to rename it.
- **Save to Disk**: `Ctrl+S` / `Cmd+S` or "💾 Save" button writes changes back to file with RFC 4180 escaping.
- **Undo / Redo & Revert**: Full `Ctrl+Z` undo, `Ctrl+Y` redo, and "↩ Revert" button to discard unsaved edits.
- **Visual Dirty Indicators**: Amber corner badge on modified cells and `●` in tab title when unsaved edits exist.
- **Extension Icon**: 256x256 high-res marketplace icon.

---

## [0.1.0] - 2026-10-15

### Initial Release
- **Explorer & Editor Context Menus**: Right-click `.csv`, `.tsv`, `.tab`, or `.txt` files to "Preview with Hello CSV".
- **Interactive Tabular Display**: Sticky header and sticky `#` row counter.
- **Instant Search & Filter**: Real-time multi-column search with match highlighting.
- **Sorting**: Numeric and alphabetical sorting on column click.
- **Pagination**: 25, 50, 100, 250, or All rows per page for 60fps performance on large files.
- **Delimiter Auto-Detection**: Supports comma, semicolon, tab, and pipe.
- **Export Options**: One-click "Copy as Markdown" and "Copy as TSV".
- **Theme-Aware**: Adapts automatically to VS Code Dark, Light, and High Contrast themes.
