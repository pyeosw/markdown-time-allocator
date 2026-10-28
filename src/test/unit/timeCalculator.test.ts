import {describe, expect, it} from 'vitest';

import {
  DEFAULT_SETTINGS,
  parseClock,
  parseSettings,
} from '../../config/settings';
import {
  calculateTime,
  formatClock,
  formatHours,
} from '../../domain/timeCalculator';

/** Validates clock boundaries, strict settings and the net-work rounding contract. */
describe('勤務時間と設定', () => {
  // Clock examples include accepted short hours and invalid 24-hour boundaries.
  it.each([
    ['9:00', 540],
    ['00:00', 0],
    ['23:59', 1439],
    [' 09:00 ', 540],
  ])('時刻 %s', (value, minutes) => {
    expect(parseClock(value)).toBe(minutes);
  });
  it.each(['24:00', '18:60', '9:0', '', '09:00foo', '-1:00', 900, null])(
    '不正な時刻 %s',
    value => {
      expect(() => parseClock(value)).toThrow();
    }
  );

  // Resource settings must not silently coerce invalid types or depth limits.
  it.each([1, 7, 2.5, '3', null])('最大深さの不正値 %s', maxHeadingDepth => {
    expect(() => parseSettings({...DEFAULT_SETTINGS, maxHeadingDepth})).toThrow(
      'maxHeadingDepth'
    );
  });
  it.each([2, 3, 6])('最大深さの有効値 %s', maxHeadingDepth => {
    expect(
      parseSettings({...DEFAULT_SETTINGS, maxHeadingDepth}).maxHeadingDepth
    ).toBe(maxHeadingDepth);
  });
  it.each([
    [''],
    ['13:00-12:00'],
    ['12:00-12:00'],
    ['12:00/13:00'],
    ['12:00-24:00'],
    [12],
  ])('不正な休憩 %s', value => {
    expect(() =>
      parseSettings({...DEFAULT_SETTINGS, breakTimes: [value]})
    ).toThrow('breakTimes');
  });
  it('設定エラーに設定キーを含める', () => {
    expect(() =>
      parseSettings({...DEFAULT_SETTINGS, startTime: '25:00'})
    ).toThrow('startTime');
    expect(() =>
      parseSettings({...DEFAULT_SETTINGS, amLeaveStartTime: false})
    ).toThrow('amLeaveStartTime');
    expect(() =>
      parseSettings({...DEFAULT_SETTINGS, breakTimes: '12:00-13:00'})
    ).toThrow('breakTimes');
  });

  // The 7/8 minute transition applies to the total after all breaks are deducted.
  it.each([
    [0, 480],
    [7, 480],
    [8, 495],
    [10, 495],
    [14, 495],
    [15, 495],
    [22, 495],
    [23, 510],
  ])('退勤18時+%i分を丸める', (extra, expected) => {
    const result = calculateTime(
      parseSettings(DEFAULT_SETTINGS),
      1080 + extra,
      'normal',
      [120, 180, 90]
    );
    expect(result.workMinutes).toBe(expected);
    expect(result.remainingMinutes).toBe(expected - 390);
    expect(result.rawMinutes).toBe(480 + extra);
  });
  it('全分数で丸め誤差が7分以内、結果が15分単位になる', () => {
    const settings = parseSettings({
      ...DEFAULT_SETTINGS,
      startTime: '00:00',
      breakTimes: [],
    });
    for (let end = 1; end < 1440; end++) {
      const result = calculateTime(settings, end, 'normal', []);
      expect(result.workMinutes % 15).toBe(0);
      expect(Math.abs(result.adjustment)).toBeLessThanOrEqual(7);
    }
  });
  it('重複・包含・隣接休憩を一度だけ控除し、勤務外を除外する', () => {
    const settings = parseSettings({
      ...DEFAULT_SETTINGS,
      breakTimes: [
        '08:00-09:00',
        '12:00-13:00',
        '12:30-13:30',
        '12:10-12:40',
        '13:30-14:00',
        '20:00-20:30',
      ],
    });
    expect(calculateTime(settings, 1080, 'normal', []).breakMinutes).toBe(120);
    expect(calculateTime(settings, 750, 'normal', []).workMinutes).toBe(180);
  });
  it('AM休暇は13時始業になり昼休憩を控除しない', () => {
    const result = calculateTime(
      parseSettings(DEFAULT_SETTINGS),
      1080,
      'amLeave',
      [120, 180, 90]
    );
    expect(result.workMinutes).toBe(300);
    expect(result.breakMinutes).toBe(0);
    expect(result.remainingMinutes).toBe(-90);
  });
  it('休憩が勤務全体を覆うと0hになる', () => {
    const settings = parseSettings({
      ...DEFAULT_SETTINGS,
      breakTimes: ['08:00-19:00'],
    });
    expect(calculateTime(settings, 1080, 'normal', []).workMinutes).toBe(0);
  });
  it.each([540, 539, 0, 1440])('退勤が不正・始業以前なら拒否 %i', end => {
    expect(() =>
      calculateTime(parseSettings(DEFAULT_SETTINGS), end, 'normal', [])
    ).toThrow();
  });
  it.each([-15, 1, 7.5, NaN, Infinity])('配分の不正値を拒否 %s', value => {
    expect(() =>
      calculateTime(parseSettings(DEFAULT_SETTINGS), 1080, 'normal', [value])
    ).toThrow();
  });
  it('h表記と時計表記を整形する', () => {
    expect([0, 15, 30, 45, 60, -15].map(formatHours)).toEqual([
      '0h',
      '0.25h',
      '0.5h',
      '0.75h',
      '1h',
      '-0.25h',
    ]);
    expect(formatClock(540)).toBe('09:00');
  });
});
