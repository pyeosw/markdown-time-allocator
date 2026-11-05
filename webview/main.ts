import type {ClientMessage, SessionView} from '../src/domain/models';
import {
  formatClock,
  formatHours,
  parseAllocationHours,
} from '../src/domain/timeCalculator';

declare function acquireVsCodeApi(): {
  postMessage(message: ClientMessage): void;
};
const api = acquireVsCodeApi();
let state: SessionView | undefined;
let busy = false;
let pendingFocus: string | undefined;
const drafts = new Map<string, string>();
let submitted:
  | {generation: number; revision: number; values: Map<string, string>}
  | undefined;

/** Refreshes input errors and permits an atomic apply of valid pending values. */
function validateInputs(): void {
  let valid = true;
  for (const input of document.querySelectorAll<HTMLInputElement>(
    '.counter input'
  )) {
    let message = '';
    try {
      parseAllocationHours(input.value);
    } catch {
      message = '0以上の0.25h単位の数値を入力してください。';
      valid = false;
    }
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', String(!!message));
    const error = element(input.getAttribute('aria-describedby') ?? '');
    error.textContent = message;
    error.hidden = !message;
    const minus =
      input.parentElement?.querySelector<HTMLButtonElement>('button');
    if (minus)
      minus.disabled =
        !state?.canAdjust ||
        busy ||
        (!message && parseAllocationHours(input.value) === 0);
  }
  element<HTMLButtonElement>('apply').disabled =
    busy ||
    !valid ||
    !(state?.canApply || (state?.canAdjust && drafts.size > 0));
}

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
    HTMLButtonElement | HTMLSelectElement | HTMLInputElement
  >('button, select, input'))
    control.disabled = true;
}

/** Sends a versioned action without optimistic arithmetic or concurrent clicks. */
function sendAction(
  message:
    | {type: 'apply'}
    | {type: 'setAllocations'}
    | {type: 'adjust'; id: string; direction: 1 | -1}
    | {type: 'changeWorkMode'; mode: 'normal' | 'amLeave'}
): void {
  if (!state || busy) return;
  submitted = {
    generation: state.generation,
    revision: state.revision,
    values: new Map(drafts),
  };
  lock();
  api.postMessage({
    ...message,
    generation: state.generation,
    revision: state.revision,
    ...(drafts.size
      ? {allocations: [...drafts].map(([id, value]) => ({id, value}))}
      : {}),
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
  if (
    submitted &&
    submitted.generation === next.generation &&
    next.revision > submitted.revision &&
    next.status !== 'stale' &&
    next.status !== 'disposed'
  ) {
    for (const [id, value] of submitted.values) {
      if (drafts.get(id) === value) drafts.delete(id);
    }
  }
  submitted = undefined;
  if (state?.generation !== next.generation) drafts.clear();
  for (const item of next.items) {
    if (drafts.get(item.id) === item.input) drafts.delete(item.id);
  }
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
  for (const [index, item] of next.items.entries()) {
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
    const value = document.createElement('input');
    value.type = 'text';
    value.inputMode = 'decimal';
    value.value = drafts.get(item.id) ?? item.input;
    value.dataset.focus = `${item.id}/input`;
    value.disabled = !next.canAdjust || busy;
    value.setAttribute(
      'aria-label',
      `${item.parentPath} ${item.name}の作業時間（時間単位）`.trim()
    );
    value.setAttribute('aria-describedby', `input-error-${index}`);
    const inputError = document.createElement('small');
    inputError.id = `input-error-${index}`;
    inputError.className = 'input-error';
    inputError.setAttribute('aria-live', 'polite');
    value.addEventListener('input', () => {
      if (value.value === item.input) drafts.delete(item.id);
      else drafts.set(item.id, value.value);
      validateInputs();
    });
    value.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        sendAction({type: 'setAllocations'});
      }
    });
    value.addEventListener('blur', event => {
      // Buttons commit drafts in the same request as their action, avoiding a lost click.
      if (
        event.relatedTarget instanceof HTMLElement &&
        event.relatedTarget.closest('button, select')
      )
        return;
      if (drafts.size) {
        const focus =
          event.relatedTarget instanceof HTMLElement
            ? event.relatedTarget.dataset.focus
            : undefined;
        sendAction({type: 'setAllocations'});
        if (focus) pendingFocus = focus;
      }
    });
    for (const direction of [-1, 1] as const) {
      if (direction === 1) {
        const unit = document.createElement('span');
        unit.textContent = 'h';
        counter.append(value, unit);
      }
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
    const controls = document.createElement('div');
    controls.append(counter, inputError);
    row.append(label, controls);
    items.append(row);
  }
  element('other').textContent = result
    ? formatHours(result.remainingMinutes)
    : '—';
  element('other').classList.toggle(
    'negative',
    !!result && result.remainingMinutes < 0
  );
  validateInputs();
  element<HTMLButtonElement>('reload').disabled =
    busy || next.status === 'disposed';
  element<HTMLButtonElement>('close').disabled = busy;
  if (active) {
    for (const control of items.querySelectorAll<HTMLElement>(
      'button, input'
    )) {
      if (control.dataset.focus === active) control.focus();
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
  if (!busy)
    api.postMessage(
      drafts.size ? {type: 'reload', hasDrafts: true} : {type: 'reload'}
    );
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
