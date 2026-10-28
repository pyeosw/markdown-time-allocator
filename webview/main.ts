import type {ClientMessage, SessionView} from '../src/domain/models';
import {formatClock, formatHours} from '../src/domain/timeCalculator';

declare function acquireVsCodeApi(): {
  postMessage(message: ClientMessage): void;
};
const api = acquireVsCodeApi();
let state: SessionView | undefined;
let busy = false;
let pendingFocus: string | undefined;

/** Requires a static shell element and fails early if the shell is inconsistent. */
function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

/** Disables mutating controls until the extension acknowledges the current revision. */
function lock(): void {
  pendingFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.focus
      : undefined;
  busy = true;
  for (const control of document.querySelectorAll<
    HTMLButtonElement | HTMLSelectElement
  >('button, select'))
    control.disabled = true;
}

/** Sends a versioned action without optimistic arithmetic or concurrent clicks. */
function sendAction(
  message:
    | {type: 'apply'}
    | {type: 'adjust'; id: string; direction: 1 | -1}
    | {type: 'changeWorkMode'; mode: 'normal' | 'amLeave'}
): void {
  if (!state || busy) return;
  lock();
  api.postMessage({
    ...message,
    generation: state.generation,
    revision: state.revision,
  });
}

/** Updates controls from authoritative state while retaining the active counter. */
function render(next: SessionView, fileName: string): void {
  const active =
    pendingFocus ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.focus
      : undefined);
  pendingFocus = undefined;
  state = next;
  busy = next.status === 'applying';
  element('target').textContent = `${fileName} / ${next.title}`;
  const mode = element<HTMLSelectElement>('mode');
  mode.value = next.mode;
  mode.disabled = !next.canAdjust || busy;
  const result = next.calculation;
  element('schedule').textContent = result
    ? `${formatClock(result.start)} → ${formatClock(result.end)} / 休憩 ${result.breakMinutes}分`
    : '勤務情報を確認してください';
  const summary = element('summary');
  summary.replaceChildren();
  for (const [label, value] of [
    ['実働時間', result?.workMinutes],
    ['配分済み', result?.allocatedMinutes],
    ['残時間', result?.remainingMinutes],
  ] as const) {
    const card = document.createElement('div');
    const caption = document.createElement('span');
    caption.textContent = label;
    const amount = document.createElement('strong');
    amount.textContent = value === undefined ? '—' : formatHours(value);
    if (value !== undefined && value < 0) card.className = 'negative';
    card.append(caption, amount);
    summary.append(card);
  }
  element('rounding').textContent = result
    ? `丸め前 ${result.rawMinutes}分 / 調整 ${result.adjustment >= 0 ? '+' : ''}${result.adjustment}分（端数7分以下は切り捨て、8分以上は切り上げ）`
    : '';
  const errors = element('errors');
  errors.replaceChildren();
  errors.hidden = next.errors.length === 0;
  for (const message of next.errors) {
    const paragraph = document.createElement('p');
    paragraph.textContent = message;
    errors.append(paragraph);
  }
  const items = element('items');
  items.replaceChildren();
  for (const item of next.items) {
    const row = document.createElement('div');
    row.className = 'item';
    const label = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.name;
    const path = document.createElement('small');
    path.textContent = item.parentPath;
    label.append(title, path);
    const counter = document.createElement('div');
    counter.className = 'counter';
    const value = document.createElement('output');
    value.textContent = formatHours(item.minutes);
    value.setAttribute('aria-label', `${item.name}の作業時間`);
    for (const direction of [-1, 1] as const) {
      if (direction === 1) counter.append(value);
      const button = document.createElement('button');
      button.textContent = direction === 1 ? '+' : '−';
      button.dataset.focus = `${item.id}/${direction}`;
      button.setAttribute(
        'aria-label',
        `${item.parentPath} ${item.name}を0.25h${direction === 1 ? '増やす' : '減らす'}`.trim()
      );
      button.disabled =
        !next.canAdjust || busy || (direction === -1 && item.minutes === 0);
      button.addEventListener('click', () =>
        sendAction({type: 'adjust', id: item.id, direction})
      );
      counter.append(button);
    }
    row.append(label, counter);
    items.append(row);
  }
  element('other').textContent = result
    ? formatHours(result.remainingMinutes)
    : '—';
  element('other').classList.toggle(
    'negative',
    !!result && result.remainingMinutes < 0
  );
  element<HTMLButtonElement>('apply').disabled = !next.canApply || busy;
  element<HTMLButtonElement>('reload').disabled =
    busy || next.status === 'disposed';
  element<HTMLButtonElement>('close').disabled = busy;
  if (active) {
    for (const button of items.querySelectorAll<HTMLButtonElement>('button')) {
      if (button.dataset.focus === active) button.focus();
    }
  }
}

element('mode').addEventListener('change', () => {
  const mode = element<HTMLSelectElement>('mode').value;
  if (mode === 'normal' || mode === 'amLeave')
    sendAction({type: 'changeWorkMode', mode});
});
element('apply').addEventListener('click', () => {
  element('feedback').textContent = '';
  sendAction({type: 'apply'});
});
element('reload').addEventListener('click', () => {
  if (!busy) api.postMessage({type: 'reload'});
});
element('close').addEventListener('click', () =>
  api.postMessage({type: 'close'})
);
window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data;
  if (message?.type === 'state')
    render(message.state as SessionView, String(message.fileName));
  else if (message?.type === 'applyResult')
    element('feedback').textContent = String(message.message);
});
api.postMessage({type: 'ready'});
