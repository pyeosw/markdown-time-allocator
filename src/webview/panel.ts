import {randomBytes} from 'node:crypto';
import * as vscode from 'vscode';

import {
  AllocationSession,
  parseClientMessage,
} from '../application/allocationSession';
import {DEFAULT_SETTINGS, errorMessage} from '../config/settings';
import {ClientMessage, RawSettings, SessionView} from '../domain/models';
import {parseDocument} from '../markdown/parser';

import {webviewHtml} from './html';
/** Reads effective resource settings, including unsaved document resources. */
function readSettings(uri: vscode.Uri): RawSettings {
  const configuration = vscode.workspace.getConfiguration(
    'timeCalculator',
    uri
  );
  return {
    startTime: configuration.get('startTime', DEFAULT_SETTINGS.startTime),
    amLeaveStartTime: configuration.get(
      'amLeaveStartTime',
      DEFAULT_SETTINGS.amLeaveStartTime
    ),
    breakTimes: configuration.get('breakTimes', DEFAULT_SETTINGS.breakTimes),
    maxHeadingDepth: configuration.get(
      'maxHeadingDepth',
      DEFAULT_SETTINGS.maxHeadingDepth
    ),
  };
}

/** Bridges a fixed document session with a single, restricted Webview panel. */
export class AllocationPanel implements vscode.Disposable {
  readonly session: AllocationSession;
  private readonly panel: vscode.WebviewPanel;
  private readonly subscriptions: vscode.Disposable[] = [];
  private trackedStart?: number;
  private trackedEnd: number;
  private readonly headingSource: string;
  private settingsSnapshot: string;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private pending?: {
    text: string;
    version: number;
    sawSelf: boolean;
    interfered: boolean;
  };

  /** Creates one session, its view and all document/configuration subscriptions. */
  constructor(
    extensionUri: vscode.Uri,
    readonly document: vscode.TextDocument,
    offset: number,
    private readonly onDispose: () => void,
    private readonly applyWorkspaceEdit: (
      edit: vscode.WorkspaceEdit
    ) => Thenable<boolean> = edit => vscode.workspace.applyEdit(edit)
  ) {
    const raw = readSettings(document.uri);
    this.session = new AllocationSession(
      document.getText(),
      offset,
      raw,
      document.version
    );
    this.settingsSnapshot = JSON.stringify(raw);
    this.trackedStart = this.session.day.start;
    this.trackedEnd = this.session.day.headingEnd;
    this.headingSource = document
      .getText()
      .slice(this.trackedStart, this.trackedEnd);
    const resources = vscode.Uri.joinPath(extensionUri, 'dist');
    this.panel = vscode.window.createWebviewPanel(
      'timeCalculator.allocation',
      '作業時間の配分',
      {viewColumn: vscode.ViewColumn.Beside, preserveFocus: false},
      {enableScripts: true, localResourceRoots: [resources]}
    );
    this.panel.webview.html = this.html(resources);
    this.subscriptions.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((value: unknown) => {
        void this.receive(value);
      }),
      vscode.workspace.onDidChangeTextDocument(event =>
        this.documentChanged(event)
      ),
      vscode.workspace.onDidCloseTextDocument(closed => {
        if (closed.uri.toString() === document.uri.toString()) {
          this.session.setStatus('disposed');
          this.sendState();
        }
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (
          event.affectsConfiguration('timeCalculator', document.uri) &&
          JSON.stringify(readSettings(document.uri)) !== this.settingsSnapshot
        ) {
          if (this.pending) this.pending.interfered = true;
          this.session.setStatus('stale');
          this.sendState();
        }
      })
    );
  }

  /** Exposes a snapshot for integration tests without a separate testing command. */
  get state(): SessionView {
    return this.session.view;
  }

  /** Identifies the currently tracked block, independent of the active editor. */
  matches(document: vscode.TextDocument, start: number): boolean {
    return (
      !this.document.isClosed &&
      this.document.uri.toString() === document.uri.toString() &&
      this.trackedStart === start
    );
  }

  /** Brings the same panel forward without discarding its values. */
  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }

  /** Serializes received operations and contains unexpected asynchronous failures. */
  receive(value: unknown): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        if (this.disposed) return;
        const message = parseClientMessage(value);
        if (!message) {
          this.sendState();
          return;
        }
        await this.processMessage(message);
      })
      .catch(error => {
        if (!this.disposed) {
          void vscode.window.showErrorMessage(errorMessage(error));
          this.sendState();
        }
      });
    return this.queue;
  }

  /** Dispatches validated messages, rejecting obsolete revision-bearing requests. */
  private async processMessage(message: ClientMessage): Promise<void> {
    if ('generation' in message && !this.session.accepts(message)) {
      this.sendState();
      return;
    }
    switch (message.type) {
      case 'ready':
        this.sendState();
        break;
      case 'adjust':
        this.session.adjust(message.id, message.direction);
        this.sendState();
        break;
      case 'changeWorkMode':
        this.session.changeWorkMode(message.mode);
        this.sendState();
        break;
      case 'apply':
        await this.apply();
        break;
      case 'reload':
        if (await this.confirmDiscard('再読込')) this.reload();
        break;
      case 'close':
        this.dispose();
        break;
    }
  }

  /** Requests discard only when an explicit reload or target switch loses input. */
  async confirmDiscard(action: string): Promise<boolean> {
    if (!this.session.dirty) return true;
    const choice = await vscode.window.showWarningMessage(
      `未適用の入力を破棄して${action}しますか？`,
      {modal: true},
      '破棄する'
    );
    return choice === '破棄する';
  }

  /** Verifies that the unchanged H1 still exists at the event-tracked location. */
  private targetOffset(): number {
    if (this.document.isClosed || this.trackedStart === undefined) {
      throw new Error(
        '対象を追跡できません。文書の対象位置でコマンドを再実行してください。'
      );
    }
    const text = this.document.getText();
    const heading = parseDocument(text).headings.find(
      candidate =>
        candidate.depth === 1 && candidate.start === this.trackedStart
    );
    if (
      !heading ||
      text.slice(heading.start, heading.headingEnd) !== this.headingSource
    ) {
      throw new Error(
        '対象の見出しが変わりました。対象位置でコマンドを再実行してください。'
      );
    }
    return heading.start;
  }

  /** Reloads effective settings and text after discard has been approved. */
  private reload(): void {
    try {
      const offset = this.targetOffset();
      const raw = readSettings(this.document.uri);
      this.session.reload(
        this.document.getText(),
        offset,
        raw,
        this.document.version
      );
      this.settingsSnapshot = JSON.stringify(raw);
      this.trackedEnd = this.session.day.headingEnd;
    } catch (error) {
      this.session.setStatus(this.document.isClosed ? 'disposed' : 'stale');
      void vscode.window.showWarningMessage(errorMessage(error));
    }
    this.sendState();
  }

  /** Tracks preceding edits while invalidating a snapshot on any external change. */
  private documentChanged(event: vscode.TextDocumentChangeEvent): void {
    if (
      event.document.uri.toString() !== this.document.uri.toString() ||
      !event.contentChanges.length
    )
      return;
    if (
      this.pending &&
      !this.pending.sawSelf &&
      event.document.version === this.pending.version + 1 &&
      event.document.getText() === this.pending.text
    ) {
      this.pending.sawSelf = true;
      return;
    }
    if (
      event.document.version === this.session.version &&
      event.document.getText() === this.session.text
    )
      return;
    if (this.pending) this.pending.interfered = true;
    if (this.trackedStart !== undefined) {
      let shift = 0;
      for (const change of event.contentChanges) {
        const end = change.rangeOffset + change.rangeLength;
        if (
          end <= this.trackedStart &&
          change.rangeOffset < this.trackedStart
        ) {
          shift += change.text.length - change.rangeLength;
        } else if (
          change.rangeOffset <= this.trackedEnd &&
          end >= this.trackedStart
        ) {
          this.trackedStart = undefined;
          break;
        }
      }
      if (this.trackedStart !== undefined) {
        this.trackedStart += shift;
        this.trackedEnd += shift;
      }
    }
    this.session.setStatus('stale');
    this.sendState();
  }

  /** Rechecks snapshots and atomically applies only validated text edits. */
  private async apply(): Promise<void> {
    if (!this.session.view.canApply) {
      this.sendState();
      return;
    }
    if (
      this.document.isClosed ||
      this.document.version !== this.session.version ||
      JSON.stringify(readSettings(this.document.uri)) !== this.settingsSnapshot
    ) {
      this.session.setStatus(this.document.isClosed ? 'disposed' : 'stale');
      this.sendState();
      return;
    }
    let plan;
    try {
      plan = this.session.plan();
    } catch (error) {
      this.session.validationError(errorMessage(error));
      this.sendState();
      return;
    }
    const mode = this.session.mode;
    const offset = this.session.day.start;
    const version = this.session.version;
    const edit = new vscode.WorkspaceEdit();
    for (const change of plan.edits) {
      edit.replace(
        this.document.uri,
        new vscode.Range(
          this.document.positionAt(change.start),
          this.document.positionAt(change.end)
        ),
        change.text
      );
    }
    this.session.setStatus('applying');
    this.pending = {
      text: plan.text,
      version,
      sawSelf: false,
      interfered: false,
    };
    this.sendState();
    let success = false;
    try {
      // No await between the final version check and the edit API call.
      success =
        this.document.version === version &&
        (plan.edits.length === 0 || (await this.applyWorkspaceEdit(edit)));
      if (this.disposed) return;
      if (
        !success ||
        this.pending.interfered ||
        this.document.getText() !== plan.text ||
        this.document.isClosed
      ) {
        if (
          this.pending.interfered ||
          this.document.version !== version ||
          this.document.isClosed
        ) {
          this.session.setStatus(this.document.isClosed ? 'disposed' : 'stale');
        } else this.session.finishFailure();
        this.sendResult(
          false,
          '反映できませんでした。文書の状態・書き込み権限を確認してください。'
        );
      } else {
        this.session.reload(
          this.document.getText(),
          offset,
          readSettings(this.document.uri),
          this.document.version,
          mode
        );
        this.trackedStart = this.session.day.start;
        this.trackedEnd = this.session.day.headingEnd;
        this.sendResult(
          true,
          plan.edits.length ? '作業時間を反映しました。' : '変更はありません。'
        );
      }
    } catch (error) {
      if (this.pending?.interfered) this.session.setStatus('stale');
      else this.session.finishFailure();
      this.sendResult(false, `反映できませんでした: ${errorMessage(error)}`);
    } finally {
      this.pending = undefined;
      this.sendState();
    }
  }

  /** Sends a complete authoritative state after each message or lifecycle change. */
  private sendState(): void {
    if (!this.disposed)
      void this.panel.webview.postMessage({
        type: 'state',
        state: this.state,
        fileName: vscode.workspace.asRelativePath(this.document.uri),
      });
  }

  /** Sends feedback separately from validation and keeps the input on failure. */
  private sendResult(success: boolean, message: string): void {
    if (!this.disposed)
      void this.panel.webview.postMessage({
        type: 'applyResult',
        success,
        message,
      });
  }

  /** Builds a static shell; workspace text is sent as data, never HTML. */
  private html(resources: vscode.Uri): string {
    const webview = this.panel.webview;
    const script = webview
      .asWebviewUri(vscode.Uri.joinPath(resources, 'webview.js'))
      .toString();
    const style = webview
      .asWebviewUri(vscode.Uri.joinPath(resources, 'webview.css'))
      .toString();
    const nonce = randomBytes(18).toString('base64');
    return webviewHtml(webview.cspSource, script, style, nonce);
  }

  /** Releases every subscription and prevents subsequent messages from editing. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.session.setStatus('disposed');
    for (const subscription of this.subscriptions) subscription.dispose();
    this.panel.dispose();
    this.onDispose();
  }
}
