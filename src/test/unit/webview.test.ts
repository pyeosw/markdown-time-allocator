// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AllocationSession} from '../../application/allocationSession';
import {DEFAULT_SETTINGS} from '../../config/settings';
import {SessionView} from '../../domain/models';
import {webviewHtml} from '../../webview/html';
import {EXAMPLE} from '../fixtures';

/** Verifies the shipped shell and UI script with the same messages as the host. */
describe('配分画面', () => {
  const postMessage = vi.fn();
  let listeners: Array<[string, EventListenerOrEventListenerObject]>;

  beforeEach(async () => {
    vi.resetModules();
    postMessage.mockReset();
    vi.stubGlobal('acquireVsCodeApi', () => ({postMessage}));
    const shell = new DOMParser().parseFromString(
      webviewHtml('vscode-resource:', 'webview.js', 'webview.css', 'testnonce'),
      'text/html'
    );
    document.head.innerHTML = shell.head.innerHTML;
    document.body.innerHTML = shell.body.innerHTML;
    const spy = vi.spyOn(window, 'addEventListener');
    await import('../../../webview/main');
    listeners = spy.mock.calls.map(call => [call[0], call[1]]);
    spy.mockRestore();
  });
  afterEach(() => {
    for (const [type, listener] of listeners)
      window.removeEventListener(type, listener);
    vi.unstubAllGlobals();
  });

  /** Delivers an authoritative state exactly as Webview.postMessage would. */
  function show(state: SessionView): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {type: 'state', state, fileName: '勤務.md'},
      })
    );
  }

  /** Requires a real button rather than bypassing UI behavior with a handler call. */
  function button(selector: string): HTMLButtonElement {
    const result = document.querySelector<HTMLButtonElement>(selector);
    if (!result) throw new Error(`Missing button: ${selector}`);
    return result;
  }

  it('初期状態を要求し、実働・丸め・カウンターを表示する', () => {
    expect(postMessage).toHaveBeenCalledWith({type: 'ready'});
    show(new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS).view);
    expect(document.querySelector('#summary')?.textContent).toContain('8h');
    expect(document.querySelector('#rounding')?.textContent).toContain(
      '丸め前 480分'
    );
    expect(document.querySelectorAll('.item')).toHaveLength(3);
    expect(button('.counter button').disabled).toBe(true);
    expect(button('#apply').disabled).toBe(false);
  });
  it('加算ボタンは世代・リビジョンを送り、応答までは連打を防ぐ', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    show(session.view);
    const plus = button('.counter button:last-child');
    plus.focus();
    plus.click();
    plus.click();
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'adjust',
      id: session.day.items[0].id,
      direction: 1,
      generation: session.generation,
      revision: session.revision,
    });
    expect(button('#apply').disabled).toBe(true);
    session.adjust(session.day.items[0].id, 1);
    show(session.view);
    expect(document.querySelector('output')?.textContent).toBe('0.25h');
    expect(button('.counter button:last-child').disabled).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toContain(
      '増やす'
    );
  });
  it('超過は負数とエラーテキストを示し、減算で修正できる', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    for (let i = 0; i < 33; i++) session.adjust(session.day.items[0].id, 1);
    show(session.view);
    expect(document.querySelector('#other')?.textContent).toBe('-0.25h');
    expect(document.querySelector('[role=alert]')?.textContent).toContain(
      '超過'
    );
    expect(button('#apply').disabled).toBe(true);
    expect(button('.counter button').disabled).toBe(false);
  });
  it('更新待ちではカウンターを無効にして再読込を提供する', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    session.setStatus('stale');
    show(session.view);
    expect(button('.counter button:last-child').disabled).toBe(true);
    expect(button('#reload').disabled).toBe(false);
    button('#reload').click();
    expect(postMessage).toHaveBeenLastCalledWith({type: 'reload'});
  });
  it('勤務区分、適用、閉じるの操作を送信する', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    show(session.view);
    const select = document.querySelector<HTMLSelectElement>('#mode');
    if (!select) throw new Error('Missing mode');
    select.value = 'amLeave';
    select.dispatchEvent(new Event('change'));
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'changeWorkMode',
      mode: 'amLeave',
      generation: session.generation,
      revision: session.revision,
    });
    show(session.view);
    button('#apply').click();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: 'apply',
      generation: session.generation,
      revision: session.revision,
    });
    show(session.view);
    button('#close').click();
    expect(postMessage).toHaveBeenLastCalledWith({type: 'close'});
  });
  it('見出しと通知中のHTMLを実行せずテキストで表示する', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    const view = session.view;
    view.items[0].name = '<img src=x onerror=alert(1)>';
    show(view);
    expect(document.querySelector('.item strong')?.textContent).toBe(
      view.items[0].name
    );
    expect(document.querySelector('.item img')).toBeNull();
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {type: 'applyResult', message: '<script>bad()</script>'},
      })
    );
    expect(document.querySelector('#feedback')?.textContent).toBe(
      '<script>bad()</script>'
    );
    expect(document.querySelector('#feedback script')).toBeNull();
    expect(
      document.querySelector('meta[http-equiv]')?.getAttribute('content')
    ).toContain("default-src 'none'");
  });
});
