import * as vscode from 'vscode';

import {errorMessage} from './config/settings';
import {parseDay} from './markdown/parser';
import {AllocationPanel} from './webview/panel';

export interface ExtensionApi {
  getPanel(): AllocationPanel | undefined;
}

/** Registers the allocation command and owns the single active panel. */
export function activate(context: vscode.ExtensionContext): ExtensionApi {
  let current: AllocationPanel | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('timeCalculator.allocate', async () => {
      try {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
          void vscode.window.showWarningMessage(
            'Markdownエディターで対象位置にカーソルを置いてください。'
          );
          return;
        }
        const document = editor.document;
        const selectedVersion = document.version;
        const offset = document.offsetAt(editor.selection.active);
        const day = parseDay(document.getText(), offset);
        if (current?.matches(document, day.start)) {
          current.reveal();
          return;
        }
        if (current && !(await current.confirmDiscard('対象を切り替え')))
          return;
        // A modal confirmation may allow the document to change before we resume.
        if (document.isClosed) return;
        if (document.version !== selectedVersion)
          throw new Error(
            '選択中に文書が変更されました。対象位置でコマンドを再実行してください。'
          );
        current?.dispose();
        current = new AllocationPanel(
          context.extensionUri,
          document,
          offset,
          () => {
            current = undefined;
          }
        );
      } catch (error) {
        void vscode.window.showWarningMessage(errorMessage(error));
      }
    }),
    {dispose: () => current?.dispose()}
  );
  return {getPanel: () => current};
}
