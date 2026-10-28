import {describe, expect, it} from 'vitest';

import {
  AllocationSession,
  parseClientMessage,
} from '../../application/allocationSession';
import {DEFAULT_SETTINGS} from '../../config/settings';
import {EXAMPLE} from '../fixtures';

/** Tests authoritative counters, recovery paths, stale snapshots and input validation. */
describe('配分セッション', () => {
  it('0hの初期値と8hのその他から開始し、0未満には減算しない', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    expect(session.view.calculation?.remainingMinutes).toBe(480);
    session.adjust(session.day.items[0].id, -1);
    expect(session.day.items[0].minutes).toBe(0);
    expect(session.dirty).toBe(false);
    session.adjust('unknown', 1);
    expect(session.dirty).toBe(false);
  });
  it('超過を負数で示し、減算で適用可能に戻る', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    const id = session.day.items[0].id;
    for (let i = 0; i < 33; i++) session.adjust(id, 1);
    expect(session.view.calculation?.remainingMinutes).toBe(-15);
    expect(session.view.canApply).toBe(false);
    expect(session.view.canAdjust).toBe(true);
    expect(() => session.plan()).toThrow();
    session.adjust(id, -1);
    expect(session.view.canApply).toBe(true);
    expect(session.plan().text).not.toContain('## その他');
  });
  it('AM休暇切替でも配分を保持し、始業以前の退勤も切替で修正できる', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    session.adjust(session.day.items[0].id, 1);
    session.changeWorkMode('amLeave');
    expect(session.view.calculation?.workMinutes).toBe(300);
    expect(session.day.items[0].minutes).toBe(15);
    const early = new AllocationSession(
      EXAMPLE.replace('18:00', '12:00'),
      0,
      DEFAULT_SETTINGS
    );
    early.changeWorkMode('amLeave');
    expect(early.view.canApply).toBe(false);
    early.changeWorkMode('normal');
    expect(early.view.canApply).toBe(true);
  });
  it('文書と設定のエラーはパネルに残し、適用を禁止する', () => {
    const invalid = new AllocationSession(EXAMPLE, 0, {
      ...DEFAULT_SETTINGS,
      maxHeadingDepth: 7,
    });
    expect(invalid.view.errors.join()).toContain('maxHeadingDepth');
    expect(invalid.view.canAdjust).toBe(false);
    const missing = new AllocationSession('# 日\n## A', 0, DEFAULT_SETTINGS);
    expect(missing.view.status).toBe('invalid');
    expect(missing.view.canApply).toBe(false);
  });
  it('再読込で世代を更新し、古い画面のメッセージを拒否する', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    const old = {generation: session.generation, revision: session.revision};
    session.adjust(session.day.items[0].id, 1);
    expect(session.accepts(old)).toBe(false);
    session.reload(EXAMPLE, 0, DEFAULT_SETTINGS, 2);
    expect(session.accepts(old)).toBe(false);
    expect(session.dirty).toBe(false);
    expect(session.version).toBe(2);
    expect(session.mode).toBe('normal');
  });
  it.each(['stale', 'applying', 'disposed'] as const)(
    '%sでは操作・適用を禁止する',
    status => {
      const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
      session.setStatus(status);
      session.adjust(session.day.items[0].id, 1);
      expect(session.day.items[0].minutes).toBe(0);
      expect(session.view.canApply).toBe(false);
      expect(session.view.canAdjust).toBe(false);
    }
  );
  it('編集失敗時は入力を保持して再試行できる', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    session.adjust(session.day.items[0].id, 1);
    session.setStatus('applying');
    session.finishFailure();
    expect(session.view.canApply).toBe(true);
    expect(session.day.items[0].minutes).toBe(15);
    session.validationError('構造を修正してください');
    expect(session.view.canApply).toBe(false);
    expect(session.view.errors.join()).toContain('構造');
  });
  it('適用後の再読込はAM休暇を保持し、Markdownの値を復元する', () => {
    const session = new AllocationSession(EXAMPLE, 0, DEFAULT_SETTINGS);
    session.adjust(session.day.items[0].id, 1);
    session.changeWorkMode('amLeave');
    const plan = session.plan();
    session.reload(plan.text, 0, DEFAULT_SETTINGS, 2, session.mode);
    expect(session.mode).toBe('amLeave');
    expect(session.day.items[0].minutes).toBe(15);
    expect(session.dirty).toBe(false);
    expect(session.plan().edits).toHaveLength(0);
  });

  // Invalid messages cannot smuggle arbitrary edits, values or file locations.
  it.each([
    null,
    1,
    {},
    {type: 'edit', uri: 'file:///x'},
    {type: 'apply'},
    {type: 'adjust', generation: 1, revision: 1, id: 'x', direction: 15},
    {type: 'changeWorkMode', generation: 1, revision: 1, mode: 'night'},
    {type: 'apply', generation: NaN, revision: 0},
  ])('不正メッセージを拒否', value => {
    expect(parseClientMessage(value)).toBeUndefined();
  });
  it('許可された操作だけを抽出する', () => {
    expect(
      parseClientMessage({
        type: 'adjust',
        generation: 1,
        revision: 2,
        id: 'x',
        direction: 1,
        uri: 'untrusted',
      })
    ).toEqual({
      type: 'adjust',
      generation: 1,
      revision: 2,
      id: 'x',
      direction: 1,
    });
    expect(parseClientMessage({type: 'ready'})).toEqual({type: 'ready'});
  });
});
