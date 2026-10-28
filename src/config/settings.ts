import {RawSettings, WorkSettings} from '../domain/models';

export const DEFAULT_SETTINGS: RawSettings = {
  startTime: '09:00',
  amLeaveStartTime: '13:00',
  breakTimes: ['12:00-13:00'],
  maxHeadingDepth: 6,
};

/** Parses a same-day 24-hour clock into integer minutes. */
export function parseClock(value: unknown): number {
  if (typeof value !== 'string')
    throw new Error('時刻は文字列で指定してください。');
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(value.trim());
  if (!match || Number(match[1]) > 23)
    throw new Error(`不正な時刻です: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Validates configuration without coercion or silently replacing invalid values. */
export function parseSettings(raw: RawSettings): WorkSettings {
  const clocks: number[] = [];
  for (const key of ['startTime', 'amLeaveStartTime'] as const) {
    try {
      clocks.push(parseClock(raw[key]));
    } catch (error) {
      throw new Error(`timeCalculator.${key}: ${errorMessage(error)}`);
    }
  }
  if (!Array.isArray(raw.breakTimes)) {
    throw new Error('timeCalculator.breakTimes: 配列で指定してください。');
  }
  const breakTimes = raw.breakTimes.map((value: unknown) => {
    try {
      if (typeof value !== 'string')
        throw new Error('文字列で指定してください。');
      const parts = value.split('-');
      if (parts.length !== 2) throw new Error('開始-終了で指定してください。');
      const start = parseClock(parts[0]);
      const end = parseClock(parts[1]);
      if (start >= end)
        throw new Error('休憩の終了は開始より後にしてください。');
      return {start, end};
    } catch (error) {
      throw new Error(`timeCalculator.breakTimes: ${errorMessage(error)}`);
    }
  });
  const depth = raw.maxHeadingDepth;
  if (
    typeof depth !== 'number' ||
    !Number.isInteger(depth) ||
    depth < 2 ||
    depth > 6
  ) {
    throw new Error(
      'timeCalculator.maxHeadingDepth: 2〜6の整数で指定してください。'
    );
  }
  return {
    startTime: clocks[0],
    amLeaveStartTime: clocks[1],
    breakTimes,
    maxHeadingDepth: depth,
  };
}

/** Converts a caught value to a safe user-facing message. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '処理に失敗しました。';
}
