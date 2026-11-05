import {errorMessage, parseSettings} from '../config/settings';
import {
  ClientMessage,
  AllocationInput,
  DayBlock,
  EditPlan,
  RawSettings,
  SessionStatus,
  SessionView,
  WorkMode,
  WorkSettings,
} from '../domain/models';
import {calculateTime, parseAllocationHours} from '../domain/timeCalculator';
import {planEdits} from '../markdown/editPlanner';
import {parseDay} from '../markdown/parser';

let nextGeneration = 0;

/** Validates messages before any Webview input can change the session. */
export function parseClientMessage(value: unknown): ClientMessage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Record<string, unknown>;
  if (data.type === 'ready' || data.type === 'close') return {type: data.type};
  if (data.type === 'reload')
    return data.hasDrafts === true
      ? {type: 'reload', hasDrafts: true}
      : {type: 'reload'};
  if (
    !Number.isSafeInteger(data.generation) ||
    !Number.isSafeInteger(data.revision)
  )
    return undefined;
  const generation = data.generation as number;
  const revision = data.revision as number;
  let inputs: {allocations?: AllocationInput[]} = {};
  if (data.allocations !== undefined) {
    if (!Array.isArray(data.allocations)) return undefined;
    const allocations: AllocationInput[] = [];
    for (const input of data.allocations) {
      if (
        !input ||
        typeof input !== 'object' ||
        typeof input.id !== 'string' ||
        typeof input.value !== 'string'
      )
        return undefined;
      allocations.push({id: input.id, value: input.value});
    }
    if (new Set(allocations.map(input => input.id)).size !== allocations.length)
      return undefined;
    inputs = {allocations};
  }
  if (data.type === 'apply' || data.type === 'setAllocations')
    return {type: data.type, generation, revision, ...inputs};
  if (
    data.type === 'adjust' &&
    typeof data.id === 'string' &&
    (data.direction === 1 || data.direction === -1)
  ) {
    return {
      type: 'adjust',
      generation,
      revision,
      id: data.id,
      direction: data.direction,
      ...inputs,
    };
  }
  if (
    data.type === 'changeWorkMode' &&
    (data.mode === 'normal' || data.mode === 'amLeave')
  ) {
    return {
      type: 'changeWorkMode',
      generation,
      revision,
      mode: data.mode,
      ...inputs,
    };
  }
  return undefined;
}

/** Owns allocation values and derived state independently of VSCode and the DOM. */
export class AllocationSession {
  day!: DayBlock;
  settings?: WorkSettings;
  text = '';
  version = 0;
  generation = 0;
  revision = 0;
  mode: WorkMode = 'normal';
  private statusOverride?: SessionStatus;
  private configurationErrors: string[] = [];
  private transientErrors: string[] = [];
  private baseline = '';
  private allocationInputs = new Map<string, string>();

  /** Loads a source snapshot and creates a new message generation. */
  constructor(text: string, offset: number, raw: RawSettings, version = 0) {
    this.reload(text, offset, raw, version);
  }

  /** Replaces the snapshot; ordinary reload resets mode to normal. */
  reload(
    text: string,
    offset: number,
    raw: RawSettings,
    version: number,
    mode: WorkMode = 'normal'
  ): void {
    let settings: WorkSettings | undefined;
    const configurationErrors: string[] = [];
    try {
      settings = parseSettings(raw);
    } catch (error) {
      configurationErrors.push(errorMessage(error));
    }
    const generation = ++nextGeneration;
    const day = parseDay(
      text,
      offset,
      settings?.maxHeadingDepth ?? 6,
      generation
    );
    this.text = text;
    this.version = version;
    this.generation = generation;
    this.revision++;
    this.settings = settings;
    this.configurationErrors = configurationErrors;
    this.day = day;
    this.allocationInputs = new Map(
      day.items.map(item => [item.id, String(item.minutes / 60)])
    );
    this.mode = mode;
    this.statusOverride = undefined;
    this.transientErrors = [];
    this.baseline = this.fingerprint();
  }

  /** Reports whether counters or the work mode differ from their loaded values. */
  get dirty(): boolean {
    return this.baseline !== this.fingerprint();
  }

  /** Serializes only user-editable state for discard confirmation. */
  private fingerprint(): string {
    return JSON.stringify([
      this.mode,
      this.day.items.map(item => item.minutes),
      [...this.allocationInputs.values()],
    ]);
  }

  /** Rejects messages from older document generations or displayed revisions. */
  accepts(message: {generation: number; revision: number}): boolean {
    return (
      this.generation === message.generation &&
      this.revision === message.revision
    );
  }

  /** Derives current errors, totals and permitted actions from authoritative data. */
  get view(): SessionView {
    const errors = [
      ...this.configurationErrors,
      ...this.day.errors,
      ...this.transientErrors,
    ];
    for (const item of this.day.items) {
      try {
        parseAllocationHours(this.allocationInputs.get(item.id) ?? '');
      } catch (error) {
        errors.push(`${item.heading.title}: ${errorMessage(error)}`);
      }
    }
    let calculation;
    if (this.settings && this.day.endMinutes !== undefined) {
      try {
        calculation = calculateTime(
          this.settings,
          this.day.endMinutes,
          this.mode,
          this.day.items.map(item => item.minutes)
        );
        if (calculation.remainingMinutes < 0)
          errors.push('実働時間を超過しています。');
      } catch (error) {
        errors.push(errorMessage(error));
      }
    }
    const status = this.statusOverride ?? (errors.length ? 'invalid' : 'ready');
    if (status === 'stale')
      errors.push(
        '文書または設定が変更されました。「再読込」してください。対象を追跡できない場合はコマンドを再実行してください。'
      );
    if (status === 'disposed')
      errors.push(
        '対象文書は閉じられています。文書を開いてコマンドを再実行してください。'
      );
    const canAdjust =
      (status === 'ready' || status === 'invalid') &&
      this.configurationErrors.length === 0 &&
      this.day.errors.length === 0;
    return {
      generation: this.generation,
      revision: this.revision,
      status,
      title: this.day.title,
      mode: this.mode,
      items: this.day.items.map(item => ({
        id: item.id,
        name: item.heading.title,
        parentPath: item.parentPath,
        minutes: item.minutes,
        input: this.allocationInputs.get(item.id) ?? String(item.minutes / 60),
      })),
      calculation,
      errors,
      canAdjust,
      canApply: status === 'ready',
    };
  }

  /** Retains raw input for correction and updates only valid quarter-hour values. */
  setAllocations(inputs: readonly AllocationInput[]): boolean {
    if (
      !this.view.canAdjust ||
      new Set(inputs.map(input => input.id)).size !== inputs.length ||
      inputs.some(input => !this.day.items.some(item => item.id === input.id))
    )
      return false;
    for (const item of this.day.items) {
      const input = inputs.find(input => input.id === item.id);
      if (!input) continue;
      this.allocationInputs.set(input.id, input.value);
      try {
        item.minutes = parseAllocationHours(input.value);
      } catch {
        // Keep the last valid allocation while the user corrects the raw input.
      }
    }
    if (inputs.length) {
      this.transientErrors = [];
      this.revision++;
    }
    return true;
  }

  /** Changes a known item's counter by exactly one quarter hour. */
  adjust(id: string, direction: 1 | -1): void {
    if (!this.view.canAdjust) return;
    const item = this.day.items.find(candidate => candidate.id === id);
    if (!item || (direction !== 1 && direction !== -1)) return;
    const minutes = item.minutes + direction * 15;
    if (minutes < 0 || !Number.isSafeInteger(minutes)) return;
    item.minutes = minutes;
    this.allocationInputs.set(id, String(minutes / 60));
    this.transientErrors = [];
    this.revision++;
  }

  /** Retains allocations while changing the effective starting time. */
  changeWorkMode(mode: WorkMode): void {
    if (!this.view.canAdjust || (mode !== 'normal' && mode !== 'amLeave'))
      return;
    this.mode = mode;
    this.transientErrors = [];
    this.revision++;
  }

  /** Changes lifecycle state and invalidates messages already in flight. */
  setStatus(status: 'stale' | 'applying' | 'disposed'): void {
    this.statusOverride = status;
    this.revision++;
  }

  /** Keeps inputs after an editing failure and permits a validated retry. */
  finishFailure(): void {
    this.statusOverride = undefined;
    this.transientErrors = [];
    this.revision++;
  }

  /** Blocks a failed structural plan until the input or document is corrected. */
  validationError(message: string): void {
    this.transientErrors = [message];
    this.revision++;
  }

  /** Revalidates the source and builds edits only for a ready session. */
  plan(): EditPlan {
    const view = this.view;
    if (!view.canApply || !view.calculation || !this.settings)
      throw new Error('現在の状態では適用できません。');
    const reparsed = parseDay(
      this.text,
      this.day.start,
      this.settings.maxHeadingDepth,
      this.generation
    );
    if (
      reparsed.items.some(
        (item, index) => item.id !== this.day.items[index]?.id
      ) ||
      reparsed.items.length !== this.day.items.length
    )
      throw new Error('対象項目が変更されました。');
    return planEdits(
      this.text,
      reparsed,
      this.day.items.map(item => item.minutes),
      view.calculation.remainingMinutes,
      this.settings.maxHeadingDepth
    );
  }
}
