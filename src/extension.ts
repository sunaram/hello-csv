import * as vscode from 'vscode';
import { CsvPreviewPanel } from './previewPanel';

export function activate(context: vscode.ExtensionContext) {
  const handlePreview = async (uri?: vscode.Uri, allUris?: vscode.Uri[]) => {
    let targetUri = uri;

    // 1. If uri wasn't passed directly (e.g. from Command Palette), check active editor
    if (!targetUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor) {
        targetUri = activeEditor.document.uri;
      }
    }

    // 2. If still no target uri, prompt user to select a CSV file
    if (!targetUri) {
      const files = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: {
          'CSV & Tabular Files': ['csv', 'tsv', 'tab', 'txt'],
          'All Files': ['*'],
        },
        openLabel: 'Preview with Hello CSV',
      });

      if (files && files.length > 0) {
        targetUri = files[0];
      } else {
        return; // User canceled
      }
    }

    // Determine view column: beside active editor if one is open, else active column
    const viewColumn = vscode.window.activeTextEditor
      ? vscode.ViewColumn.Beside
      : vscode.ViewColumn.Active;

    // Create or show the preview panel
    CsvPreviewPanel.createOrShow(targetUri, viewColumn);
  };

  // Primary command
  const previewCommand = vscode.commands.registerCommand('hello-csv.preview', handlePreview);

  // Backward compatibility alias command
  const legacyCommand = vscode.commands.registerCommand('csv-viewer.preview', handlePreview);

  context.subscriptions.push(previewCommand, legacyCommand);
}

export function deactivate() {
  // Clean up resources if needed
}
