import * as assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {setup, suite, teardown, test} from 'mocha';
import * as vscode from 'vscode';

import {ExtensionApi} from '../../extension';
import {parseDay} from '../../markdown/parser';
import {AllocationPanel} from '../../webview/panel';
import {EXAMPLE} from '../fixtures';

/** Waits for observable VSCode events without depending on a fixed UI delay. */
async function waitFor(condition: () => boolean): Promise<void> {
  const limit = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > limit)
      throw new Error('VSCodeの状態更新を待機中にタイムアウトしました。');
    await delay(10);
  }
}

/** Registers end-to-end command, configuration, Webview-message and editing checks. */
export function registerTests(): void {
  suite('作業時間配分 Extension Host', () => {
    let api: ExtensionApi;
    let extension: vscode.Extension<ExtensionApi>;
    const documents: vscode.TextDocument[] = [];
    let extraPanel: AllocationPanel | undefined;

    setup(async () => {
      const installed = vscode.extensions.getExtension<ExtensionApi>(
        'time-calculator-local.time-calculator-vsc'
      );
      assert.ok(installed);
      extension = installed;
      api = await extension.activate();
    });
    teardown(async () => {
      extraPanel?.dispose();
      extraPanel = undefined;
      api.getPanel()?.dispose();
      await vscode.workspace
        .getConfiguration('timeCalculator')
        .update(
          'maxHeadingDepth',
          undefined,
          vscode.ConfigurationTarget.Global
        );
      for (const document of documents.splice(0)) {
        if (!document.isClosed) {
          await vscode.window.showTextDocument(document);
          await vscode.commands.executeCommand(
            'workbench.action.revertAndCloseActiveEditor'
          );
        }
      }
    });

    /** Opens an unsaved Markdown editor and invokes the public allocation command. */
    async function open(
      source = EXAMPLE,
      offset = 0
    ): Promise<AllocationPanel> {
      const document = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: source,
      });
      documents.push(document);
      const editor = await vscode.window.showTextDocument(
        document,
        vscode.ViewColumn.One
      );
      editor.selection = new vscode.Selection(
        document.positionAt(offset),
        document.positionAt(offset)
      );
      await vscode.commands.executeCommand('timeCalculator.allocate');
      const panel = api.getPanel();
      assert.ok(panel);
      return panel;
    }

    /** Sends a current-generation counter operation through the actual message handler. */
    async function adjust(
      panel: AllocationPanel,
      direction: 1 | -1 = 1
    ): Promise<void> {
      const state = panel.state;
      await panel.receive({
        type: 'adjust',
        generation: state.generation,
        revision: state.revision,
        id: state.items[0].id,
        direction,
      });
    }

    /** Requests apply using the exact displayed revision, like the Webview. */
    async function apply(panel: AllocationPanel): Promise<void> {
      await panel.receive({
        type: 'apply',
        generation: panel.state.generation,
        revision: panel.state.revision,
      });
    }

    // Acceptance path: unsaved content, counters, Other, idempotence and one-step Undo.
    test('コマンドから適用・再適用・Undoまで動作する', async () => {
      const panel = await open();
      assert.equal(panel.state.title, '20261028');
      assert.equal(panel.state.calculation?.workMinutes, 480);
      assert.deepEqual(
        panel.state.items.map(item => item.name),
        ['作業A', '作業B', '案件B']
      );
      await adjust(panel);
      await apply(panel);
      const document = panel.document;
      const applied = document.getText();
      const day = parseDay(applied, 0);
      assert.equal(day.items[0].minutes, 15);
      assert.equal(day.other?.duration?.minutes, 465);
      assert.equal(day.other?.end, day.time?.start);
      assert.equal(
        applied.slice(applied.indexOf('# 20261029')),
        EXAMPLE.slice(EXAMPLE.indexOf('# 20261029'))
      );
      const version = document.version;
      await apply(panel);
      assert.equal(document.version, version);
      await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
      await vscode.commands.executeCommand('undo');
      await waitFor(() => document.getText() === EXAMPLE);
      assert.equal(panel.state.status, 'stale');
    });

    // Recovery path: overflow remains editable and obsolete requests do nothing.
    test('超過・古いメッセージ・不正メッセージから文書を保護する', async () => {
      const panel = await open();
      const old = panel.state;
      await adjust(panel);
      await panel.receive({
        type: 'adjust',
        generation: old.generation,
        revision: old.revision,
        id: old.items[0].id,
        direction: 1,
      });
      assert.equal(panel.state.items[0].minutes, 15);
      await panel.receive({
        type: 'adjust',
        generation: panel.state.generation,
        revision: panel.state.revision,
        id: 'unknown',
        direction: 1,
      });
      await panel.receive({type: 'edit', uri: 'file:///untrusted'});
      for (let i = 1; i < 33; i++) await adjust(panel);
      assert.equal(panel.state.calculation?.remainingMinutes, -15);
      await apply(panel);
      assert.equal(panel.document.getText(), EXAMPLE);
      await adjust(panel, -1);
      assert.equal(panel.state.canApply, true);
    });

    // Both mode changes and the 7/8 boundary use host-side calculations.
    test('AM休暇と8分の切り上げを画面メッセージから計算する', async () => {
      const panel = await open(EXAMPLE.replace('18:00', '18:08'));
      assert.equal(panel.state.calculation?.rawMinutes, 488);
      assert.equal(panel.state.calculation?.workMinutes, 495);
      await panel.receive({
        type: 'changeWorkMode',
        generation: panel.state.generation,
        revision: panel.state.revision,
        mode: 'amLeave',
      });
      assert.equal(panel.state.calculation?.workMinutes, 315);
      await apply(panel);
      assert.equal(panel.state.mode, 'amLeave');
      assert.equal(panel.state.calculation?.workMinutes, 315);
    });

    // External edits invalidate offsets; reload tracks a preceding insertion safely.
    test('見出し行への外部編集では適用を禁止して再選択する', async () => {
      const panel = await open();
      const edit = new vscode.WorkspaceEdit();
      edit.insert(panel.document.uri, new vscode.Position(0, 0), '前書き\n\n');
      await vscode.workspace.applyEdit(edit);
      await waitFor(() => panel.state.status === 'stale');
      const source = panel.document.getText();
      await apply(panel);
      assert.equal(panel.document.getText(), source);
      // Insertion at the heading itself is deliberately conservative: reselect it.
      await vscode.window.showTextDocument(
        panel.document,
        vscode.ViewColumn.One
      );
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor);
      editor.selection = new vscode.Selection(2, 0, 2, 0);
      await vscode.commands.executeCommand('timeCalculator.allocate');
      assert.notEqual(api.getPanel(), panel);
      assert.equal(api.getPanel()?.state.title, '20261028');
    });

    // A change elsewhere moves offsets but reload must keep the originally selected H1.
    test('対象より前の編集を追跡し、同じ日を再読込する', async () => {
      const panel = await open(EXAMPLE, EXAMPLE.indexOf('# 20261029'));
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        panel.document.uri,
        new vscode.Position(2, 0),
        '前日のメモ\n'
      );
      await vscode.workspace.applyEdit(edit);
      await waitFor(() => panel.state.status === 'stale');
      await panel.receive({type: 'reload'});
      assert.equal(panel.state.title, '20261029');
      assert.equal(panel.state.status, 'ready');
      await apply(panel);
      const text = panel.document.getText();
      assert.ok(
        text.slice(0, text.indexOf('# 20261029')).includes('前日のメモ')
      );
      assert.equal(
        text
          .slice(0, text.indexOf('# 20261029'))
          .includes('time-calculator:duration'),
        false
      );
    });

    // Cursor movement alone cannot change a live panel, and rerunning preserves inputs.
    test('同じ対象の再実行は入力を保持し、適用後に別の日へ切り替えられる', async () => {
      const panel = await open();
      await adjust(panel);
      const editor = await vscode.window.showTextDocument(
        panel.document,
        vscode.ViewColumn.One
      );
      editor.selection = new vscode.Selection(4, 0, 4, 0);
      await vscode.commands.executeCommand('timeCalculator.allocate');
      assert.equal(api.getPanel(), panel);
      assert.equal(panel.state.items[0].minutes, 15);
      await apply(panel);
      await vscode.window.showTextDocument(
        panel.document,
        vscode.ViewColumn.One
      );
      const next = panel.document.positionAt(
        panel.document.getText().indexOf('# 20261029')
      );
      editor.selection = new vscode.Selection(next, next);
      assert.equal(panel.state.title, '20261028');
      await vscode.commands.executeCommand('timeCalculator.allocate');
      assert.notEqual(api.getPanel(), panel);
      assert.equal(api.getPanel()?.state.title, '20261029');
    });

    // A closed document must never be silently reopened and written by an old panel.
    test('対象文書を閉じると適用できず、パネルを破棄できる', async () => {
      const panel = await open();
      await vscode.window.showTextDocument(
        panel.document,
        vscode.ViewColumn.One
      );
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor'
      );
      await waitFor(() => panel.document.isClosed);
      assert.equal(panel.state.status, 'disposed');
      await apply(panel);
      assert.equal(panel.state.canApply, false);
      await panel.receive({type: 'close'});
      assert.equal(api.getPanel(), undefined);
    });

    // Configuration changes can leave incompatible records that require explicit cleanup.
    test('深さ変更後に対象外の管理行があれば適用を禁止する', async () => {
      const panel = await open();
      await apply(panel);
      await vscode.workspace
        .getConfiguration('timeCalculator')
        .update('maxHeadingDepth', 2, vscode.ConfigurationTarget.Global);
      await waitFor(() => panel.state.status === 'stale');
      await panel.receive({type: 'reload'});
      assert.equal(panel.state.canApply, false);
      assert.ok(panel.state.errors.join().includes('配分対象外'));
    });

    // Configuration is read for the document resource and changes invalidate the panel.
    test('設定変更を再読込して案件単位へ切り替える', async () => {
      const panel = await open();
      await vscode.workspace
        .getConfiguration('timeCalculator')
        .update('maxHeadingDepth', 2, vscode.ConfigurationTarget.Global);
      await waitFor(() => panel.state.status === 'stale');
      await panel.receive({type: 'reload'});
      assert.deepEqual(
        panel.state.items.map(item => item.name),
        ['案件A', '案件B']
      );
      await apply(panel);
      assert.ok(panel.document.getText().includes('### 作業A\n- aaa'));
      assert.equal(
        parseDay(panel.document.getText(), 0, 2).items[0].minutes,
        0
      );
    });

    // Existing notes must travel with Other and be restored by one Undo.
    test('既存のその他を時間の直前へ移動しUndoで戻せる', async () => {
      const source = '# 日\n## A\n## 時間\n- 18:00\n\n## その他\n- メモ😀\n';
      const panel = await open(source);
      await apply(panel);
      const day = parseDay(panel.document.getText(), 0);
      assert.equal(day.other?.end, day.time?.start);
      assert.ok(panel.document.getText().includes('- メモ😀'));
      await vscode.window.showTextDocument(
        panel.document,
        vscode.ViewColumn.One
      );
      await vscode.commands.executeCommand('undo');
      await waitFor(() => panel.document.getText() === source);
    });

    // A failed API call must retain the counters and must not claim success.
    test('編集API失敗時は入力を保持して文書を変更しない', async () => {
      const original = await open();
      const document = original.document;
      original.dispose();
      extraPanel = new AllocationPanel(
        extension.extensionUri,
        document,
        0,
        () => {},
        async () => false
      );
      await adjust(extraPanel);
      await apply(extraPanel);
      assert.equal(document.getText(), EXAMPLE);
      assert.equal(extraPanel.state.items[0].minutes, 15);
      assert.equal(extraPanel.state.canApply, true);
    });

    // Invalid Markdown is visible in the panel but cannot be applied.
    test('解析エラーと適用連打でも誤った編集を行わない', async () => {
      const invalid = await open('# 日\n## A\n');
      assert.equal(invalid.state.canApply, false);
      await apply(invalid);
      assert.equal(invalid.document.getText(), '# 日\n## A\n');
      invalid.dispose();
      const panel = await open();
      const state = panel.state;
      const message = {
        type: 'apply',
        generation: state.generation,
        revision: state.revision,
      };
      await Promise.all([panel.receive(message), panel.receive(message)]);
      assert.equal(panel.document.getText().match(/## その他/g)?.length, 1);
    });
  });
}
