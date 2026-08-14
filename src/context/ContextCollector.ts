import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

export type EditorContextKind = 'selection' | 'file' | 'problems';

export interface EditorContextItem {
  id: string;
  kind: EditorContextKind;
  label: string;
  content: string;
  truncated: boolean;
  originalChars: number;
}

export class ContextCollector {
  async selection(): Promise<EditorContextItem> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('No active text editor.');
    }
    if (editor.selection.isEmpty) {
      throw new Error('Select some code or text first.');
    }

    const document = editor.document;
    const selection = editor.selection;
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const selectedText = document.getText(selection);
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const raw = [
      `File: ${relativePath}`,
      `Language: ${document.languageId}`,
      `Selected lines: ${startLine}-${endLine}`,
      '',
      selectedText,
    ].join('\n');

    return this.item('selection', `${relativePath}:${startLine}-${endLine}`, raw);
  }

  async file(uri?: vscode.Uri): Promise<EditorContextItem> {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      throw new Error('No active file.');
    }

    const document = await vscode.workspace.openTextDocument(target);
    const relativePath = vscode.workspace.asRelativePath(document.uri, false);
    const raw = [
      `File: ${relativePath}`,
      `Language: ${document.languageId}`,
      '',
      document.getText(),
    ].join('\n');

    return this.item('file', relativePath, raw);
  }

  async problems(): Promise<EditorContextItem> {
    const entries: string[] = [];

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (!vscode.workspace.getWorkspaceFolder(uri)) {
        continue;
      }

      const relativePath = vscode.workspace.asRelativePath(uri, false);
      for (const diagnostic of diagnostics) {
        const line = diagnostic.range.start.line + 1;
        const column = diagnostic.range.start.character + 1;
        const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? 'Diagnostic';
        const codeValue =
          typeof diagnostic.code === 'object' && diagnostic.code !== null
            ? diagnostic.code.value
            : diagnostic.code;
        const source = diagnostic.source ? ` source=${diagnostic.source}` : '';
        const code = codeValue !== undefined ? ` code=${String(codeValue)}` : '';
        entries.push(
          `${relativePath}:${line}:${column} [${severity}]${source}${code} ${diagnostic.message}`,
        );
      }
    }

    if (entries.length === 0) {
      throw new Error('No workspace diagnostics are currently reported by VS Code.');
    }

    entries.sort((a, b) => a.localeCompare(b));
    const raw = [`VS Code Problems (${entries.length})`, '', ...entries].join('\n');
    return this.item('problems', `Problems (${entries.length})`, raw);
  }

  private item(kind: EditorContextKind, label: string, raw: string): EditorContextItem {
    const maxChars = vscode.workspace
      .getConfiguration('deepseekHarness')
      .get<number>('maxContextChars', 60000);
    const limit = Math.max(1000, maxChars);
    const originalChars = raw.length;
    const truncated = originalChars > limit;
    const content = truncated
      ? `${raw.slice(0, limit)}\n\n[Context truncated by DeepSeek Harness VS Code at ${limit} characters.]`
      : raw;

    return {
      id: randomUUID(),
      kind,
      label,
      content,
      truncated,
      originalChars,
    };
  }
}
