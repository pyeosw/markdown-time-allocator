import {describe, expect, it} from 'vitest';

import {planEdits} from '../../markdown/editPlanner';
import {DURATION_MARKER, parseDay, parseDocument} from '../../markdown/parser';
import {EXAMPLE} from '../fixtures';

/** Creates a managed row for malformed/duplicate record and round-trip fixtures. */
function row(value: string): string {
  return `- 作業時間: ${value}h ${DURATION_MARKER}\n`;
}

/** Verifies CommonMark selection, source ownership and bounded leaf extraction. */
describe('Markdown解析', () => {
  it('要求例の末端と親パスを取得する', () => {
    const day = parseDay(EXAMPLE, 0);
    expect(day.errors).toEqual([]);
    expect(day.items.map(item => item.heading.title)).toEqual([
      '作業A',
      '作業B',
      '案件B',
    ]);
    expect(day.items[0].parentPath).toBe('案件A');
    expect(day.endMinutes).toBe(1080);
  });
  it('次の日の見出し・文末はその日のブロックを選択する', () => {
    expect(parseDay(EXAMPLE, EXAMPLE.indexOf('# 20261029')).title).toBe(
      '20261029'
    );
    expect(parseDay(EXAMPLE, EXAMPLE.length).title).toBe('20261029');
    expect(() => parseDay(`前書き\n${EXAMPLE}`, 0)).toThrow('見出し1');
    expect(() => parseDay('## 案件\n', 0)).toThrow();
  });
  it.each([2, 3, 6])('最大深さ%iで末端を選択する', depth => {
    const day = parseDay(EXAMPLE, 0, depth);
    expect(day.items.map(item => item.heading.title)).toEqual(
      depth === 2 ? ['案件A', '案件B'] : ['作業A', '作業B', '案件B']
    );
  });
  it('飛び階層・上限内の祖先なし・同名項目を区別する', () => {
    const source = '# 日\n#### 孤立\n## A\n#### 内訳\n## A\n## 時間\n- 18:00\n';
    const day = parseDay(source, 0, 3);
    expect(day.items.map(item => item.heading.title)).toEqual(['A', 'A']);
    expect(new Set(day.items.map(item => item.id)).size).toBe(2);
  });
  it('Setext、日本語、絵文字のUTF-16位置を保つ', () => {
    const source = '日😀\n====\n\n案件😀\n----\n\n## 時間\n- 18:00';
    const day = parseDay(source, 0);
    expect(day.title).toBe('日😀');
    expect(day.items[0].heading.start).toBe(source.indexOf('案件😀'));
    expect(
      source.slice(day.items[0].heading.start, day.items[0].heading.headingEnd)
    ).toBe('案件😀\n----');
  });
  it('コード・引用・リスト・HTML内の疑似見出しを除外する', () => {
    const source =
      '# 日\n\n```md\n# コード\n## 偽\n```\n\n> # 引用\n\n- # リスト\n\n<div>\n# HTML\n</div>\n\n    # インデント\n\n## 時間\n- 18:00\n';
    expect(
      parseDocument(source).headings.map(heading => heading.title)
    ).toEqual(['日', '時間']);
  });
  it('時間配下の見出しを配分対象から除外する', () => {
    const source = '# 日\n## A\n## 時間\n- 18:00\n### メモ\n- 19:00\n';
    const day = parseDay(source, 0);
    expect(day.errors).toEqual([]);
    expect(day.items.map(item => item.heading.title)).toEqual(['A']);
    expect(day.endMinutes).toBe(1080);
  });
  it.each([
    '',
    '## 時間\n',
    '## 時間\n- 24:00\n',
    '## 時間\n- 18:60\n',
    '## 時間\n- 18:00\n- 19:00\n',
    '## 時間\n- 18:00\n## 時間\n- 19:00\n',
    '## 時間\n1. 18:00\n',
    '## 時間\n- メモ\n  - 18:00\n',
  ])('不正な時間セクションを拒否', section => {
    expect(parseDay(`# 日\n## A\n${section}`, 0).errors.length).toBeGreaterThan(
      0
    );
  });
  it('時間セクションでは単一行プレーンテキストだけを読む', () => {
    const source =
      '# 日\n## 時間\n- メモ\n- **19:00**\n- `20:00`\n- [21:00](x)\n- 9:00\n';
    expect(parseDay(source, 0).endMinutes).toBe(540);
  });
  it.each(['## その他\n## その他\n', '## その他\n### 子\n'])(
    '曖昧なその他を拒否',
    other => {
      expect(
        parseDay(`# 日\n${other}## 時間\n- 18:00\n`, 0).errors.length
      ).toBeGreaterThan(0);
    }
  );
  it.each([
    '-0.25',
    '0.1',
    '0.2499999999999999999',
    'Infinity',
    '1e2',
    '',
    '999999999999999999999',
  ])('不正な管理行の値 %s', value => {
    expect(
      parseDay(`# 日\n## A\n${row(value)}## 時間\n- 18:00\n`, 0).errors.length
    ).toBeGreaterThan(0);
  });
  it('管理行を復元し、重複・配分対象外を拒否する', () => {
    const source = `# 日\n## A\n${row('1.25')}### 子\n${row('0.5')}## 時間\n- 18:00\n`;
    expect(parseDay(source, 0).errors.join()).toContain('配分対象外');
    expect(parseDay(source, 0, 2).errors.join()).toContain('配分対象外');
    const duplicate = `# 日\n## A\n${row('1')}${row('2')}## 時間\n- 18:00\n`;
    expect(parseDay(duplicate, 0).errors.join()).toContain('重複');
    const valid = `# 日\n## A\n${row('1.25')}## 時間\n- 18:00\n`;
    expect(parseDay(valid, 0).items[0].minutes).toBe(75);
  });
  it('引用・コード・入れ子のマーカーとユーザーの時間メモを無視する', () => {
    const source = `# 日\n## A\n- 作業時間: 3h\n\n> ${row('2')}\n~~~\n${row('4')}~~~\n\n- 親\n  ${row('5')}\n## 時間\n- 18:00\n`;
    const day = parseDay(source, 0);
    expect(day.errors).toEqual([]);
    expect(day.items[0].minutes).toBe(0);
  });
});

/** Verifies edits by reparsing output, preserving user text and repeating applications. */
describe('Markdown更新', () => {
  it('要求例を更新し、その他を時間の直前へ配置する', () => {
    const day = parseDay(EXAMPLE, 0);
    const plan = planEdits(EXAMPLE, day, [120, 180, 90], 90, 6);
    const result = parseDay(plan.text, 0);
    expect(result.items.map(item => item.minutes)).toEqual([120, 180, 90]);
    expect(result.other?.duration?.minutes).toBe(90);
    expect(result.other?.end).toBe(result.time?.start);
    expect(plan.text.slice(plan.text.indexOf('# 20261029'))).toBe(
      EXAMPLE.slice(EXAMPLE.indexOf('# 20261029'))
    );
    expect(plan.text).toContain('- aaa');
    expect(planEdits(plan.text, result, [120, 180, 90], 90, 6).edits).toEqual(
      []
    );
  });
  it('残時間0ではその他を新設せず、通常項目は0hも出力する', () => {
    const output = planEdits(
      EXAMPLE,
      parseDay(EXAMPLE, 0),
      [480, 0, 0],
      0,
      6
    ).text;
    expect(output).not.toContain('## その他');
    expect(parseDay(output, 0).items.map(item => item.minutes)).toEqual([
      480, 0, 0,
    ]);
  });
  it.each(['before', 'after'])(
    '既存のその他を本文ごと移動する: %s',
    position => {
      const other = `## その他\n${row('4')}\n- メモ😀\n\n`;
      const source = `# 日\n${position === 'before' ? other : ''}## A\n- 保持\n\n## 時間\n- 18:00\n\n${position === 'after' ? other : ''}# 次の日\n## 時間\n- 20:00\n`;
      const output = planEdits(source, parseDay(source, 0), [480], 0, 6).text;
      const day = parseDay(output, 0);
      expect(day.other?.end).toBe(day.time?.start);
      expect(day.other?.duration?.minutes).toBe(0);
      expect(output).toContain('- メモ😀');
      expect(output.match(/## その他/g)).toHaveLength(1);
      expect(planEdits(output, day, [480], 0, 6).edits).toHaveLength(0);
    }
  );
  it('通常項目なしでも全時間をその他へ配分する', () => {
    const source = '# 日\n## 時間\n- 18:00';
    const output = planEdits(source, parseDay(source, 0), [], 480, 6).text;
    expect(parseDay(output, 0).other?.duration?.minutes).toBe(480);
  });
  it('最大深さ2では親へ配分し子見出しを保持する', () => {
    const output = planEdits(
      EXAMPLE,
      parseDay(EXAMPLE, 0, 2),
      [300, 180],
      0,
      2
    ).text;
    expect(output).toContain('### 作業A\n- aaa');
    expect(parseDay(output, 0, 2).items.map(item => item.minutes)).toEqual([
      300, 180,
    ]);
  });
  it('CRLF、Setext、末尾改行なし、日本語・絵文字を保つ', () => {
    const source =
      '日😀\r\n====\r\n\r\n案件😀\r\n----\r\n- メモ\r\n\r\n## 時間\r\n- 18:00';
    const output = planEdits(source, parseDay(source, 0), [480], 0, 6).text;
    expect(output.replace(/\r\n/g, '')).not.toContain('\n');
    expect(output.endsWith('- 18:00')).toBe(true);
    expect(output).toContain('- メモ');
    expect(parseDay(output, 0).items[0].minutes).toBe(480);
  });
  it('管理行は見出し直後へ置き、後方の未終了フェンスに取り込まれない', () => {
    const source = '# 日\n## 時間\n- 18:00\n\n## A\n\n```\nメモ';
    const output = planEdits(source, parseDay(source, 0), [480], 0, 6).text;
    expect(parseDay(output, 0).items[0].minutes).toBe(480);
    expect(output.endsWith('```\nメモ')).toBe(true);
  });
  it('移動した未終了フェンスが時間を隠す場合は編集を拒否する', () => {
    const source = '# 日\n## A\n## 時間\n- 18:00\n\n## その他\n\n```\nメモ';
    expect(() => planEdits(source, parseDay(source, 0), [0], 480, 6)).toThrow(
      '構造'
    );
  });
  it('超過の負数・不正な配分は出力しない', () => {
    expect(() =>
      planEdits(EXAMPLE, parseDay(EXAMPLE, 0), [0, 0, 0], -15, 6)
    ).toThrow();
    expect(() =>
      planEdits(EXAMPLE, parseDay(EXAMPLE, 0), [1, 0, 0], 0, 6)
    ).toThrow();
  });
});
