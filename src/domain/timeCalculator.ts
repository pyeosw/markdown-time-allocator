import {CalculationResult, WorkMode, WorkSettings} from './models';

/** Unions clipped breaks and rounds the net work total only once. */
export function calculateTime(
  settings: WorkSettings,
  end: number,
  mode: WorkMode,
  allocations: readonly number[]
): CalculationResult {
  const start =
    mode === 'amLeave' ? settings.amLeaveStartTime : settings.startTime;
  if (!Number.isInteger(end) || end < 0 || end > 1439 || end <= start) {
    throw new Error(
      '退勤時刻は始業時刻より後にしてください（日付をまたぐ勤務は対象外です）。'
    );
  }
  for (const minutes of allocations) {
    if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes % 15 !== 0) {
      throw new Error('配分は0以上の0.25h単位で指定してください。');
    }
  }
  const intervals = settings.breakTimes
    .map(interval => ({
      start: Math.max(start, interval.start),
      end: Math.min(end, interval.end),
    }))
    .filter(interval => interval.start < interval.end)
    .sort((a, b) => a.start - b.start);
  let breakMinutes = 0;
  let coveredEnd = start;
  for (const interval of intervals) {
    breakMinutes += Math.max(
      0,
      interval.end - Math.max(coveredEnd, interval.start)
    );
    coveredEnd = Math.max(coveredEnd, interval.end);
  }
  const rawMinutes = end - start - breakMinutes;
  const workMinutes = Math.floor((rawMinutes + 7) / 15) * 15;
  const allocatedMinutes = allocations.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(allocatedMinutes))
    throw new Error('配分の合計が大きすぎます。');
  return {
    start,
    end,
    breakMinutes,
    rawMinutes,
    workMinutes,
    adjustment: workMinutes - rawMinutes,
    allocatedMinutes,
    remainingMinutes: workMinutes - allocatedMinutes,
  };
}

/** Formats quarter-hour minutes without redundant trailing zeroes. */
export function formatHours(minutes: number): string {
  return `${minutes / 60}h`;
}

/** Formats integer minutes as a two-digit 24-hour clock. */
export function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
