import {Node, Parser} from 'commonmark';

import {errorMessage, parseClock} from '../config/settings';
import {DayBlock, DurationLine, Heading, SourceRange} from '../domain/models';

export const DURATION_MARKER = '<!-- time-calculator:duration -->';

interface ListEntry extends SourceRange {
  raw: string;
  plain?: string;
  singleLine: boolean;
}

export interface ParsedDocument {
  headings: Heading[];
  entries: ListEntry[];
}

/** Collects the visible inline text without interpreting embedded HTML. */
function inlineText(node: Node): string {
  let text = '';
  for (let child = node.firstChild; child; child = child.next) {
    if (child.type === 'text' || child.type === 'code')
      text += child.literal ?? '';
    else if (child.type === 'softbreak' || child.type === 'linebreak')
      text += ' ';
    else text += inlineText(child);
  }
  return text.trim();
}

/** Parses CommonMark root blocks and retains offsets in the untouched source. */
export function parseDocument(text: string): ParsedDocument {
  const root = new Parser().parse(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineStarts.push(i + 1);
  }
  /** Locates the end of a physical line, excluding its newline. */
  function lineEnd(line: number): number {
    let end = lineStarts[line] ?? text.length;
    if (text[end - 1] === '\n') end--;
    if (text[end - 1] === '\r') end--;
    return end;
  }
  const headings: Heading[] = [];
  const entries: ListEntry[] = [];
  for (let node = root.firstChild; node; node = node.next) {
    const startLine = node.sourcepos[0][0];
    const endLine = node.sourcepos[1][0];
    if (node.type === 'heading') {
      headings.push({
        start: lineStarts[startLine - 1],
        headingEnd: lineEnd(endLine),
        bodyStart: lineStarts[endLine] ?? text.length,
        bodyEnd: text.length,
        end: text.length,
        depth: node.level,
        title: inlineText(node),
        line: startLine,
      });
    }
    if (node.type !== 'list' || node.listType !== 'bullet') continue;
    for (let item = node.firstChild; item; item = item.next) {
      const paragraph = item.firstChild;
      if (!paragraph || paragraph.type !== 'paragraph') continue;
      const line = paragraph.sourcepos[0][0];
      const start = lineStarts[line - 1];
      const end = lineEnd(line);
      const singleLine =
        paragraph.sourcepos[1][0] === line && paragraph.next === null;
      let plain: string | undefined;
      if (singleLine) {
        plain = '';
        for (let child = paragraph.firstChild; child; child = child.next) {
          if (child.type !== 'text') {
            plain = undefined;
            break;
          }
          plain += child.literal ?? '';
        }
      }
      entries.push({
        start,
        end,
        raw: text.slice(start, end),
        plain,
        singleLine,
      });
    }
  }
  const stack: Heading[] = [];
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    heading.bodyEnd = headings[i + 1]?.start ?? text.length;
    while (stack.length > 0 && stack[stack.length - 1].depth >= heading.depth) {
      const closed = stack.pop();
      if (closed) closed.end = heading.start;
    }
    heading.parent = stack[stack.length - 1];
    stack.push(heading);
  }
  return {headings, entries};
}

/** Checks a marker-owned duration while preserving unmarked user notes. */
function readDuration(entry: ListEntry): DurationLine {
  const match =
    /^ {0,3}[-+*]\s+作業時間: ([0-9]+(?:\.[0-9]+)?)h <!-- time-calculator:duration -->\s*$/.exec(
      entry.raw
    );
  const [whole, fraction = ''] = match?.[1].split('.') ?? [];
  const fractionalQuarters = new Map([
    ['', 0],
    ['25', 1],
    ['5', 2],
    ['75', 3],
  ]).get(fraction.replace(/0+$/, ''));
  const quarters =
    whole !== undefined && fractionalQuarters !== undefined
      ? Number(whole) * 4 + fractionalQuarters
      : NaN;
  const minutes = quarters * 15;
  if (
    !entry.singleLine ||
    !Number.isSafeInteger(quarters) ||
    !Number.isSafeInteger(minutes)
  ) {
    throw new Error('管理用時間行は0以上の0.25h単位で指定してください。');
  }
  return {start: entry.start, end: entry.end, minutes};
}

/** Selects one H1 day and extracts bounded leaf items, reserved sections and times. */
export function parseDay(
  text: string,
  offset: number,
  maxDepth = 6,
  generation = 0
): DayBlock {
  if (!Number.isInteger(maxDepth) || maxDepth < 2 || maxDepth > 6) {
    throw new Error('見出しの最大深さは2〜6で指定してください。');
  }
  const parsed = parseDocument(text);
  const dayHeading = parsed.headings.find(
    heading =>
      heading.depth === 1 &&
      heading.start <= offset &&
      (offset < heading.end ||
        (offset === text.length && heading.end === text.length))
  );
  if (!dayHeading)
    throw new Error('対象の見出し1または本文にカーソルを置いてください。');
  const headings = parsed.headings.filter(
    heading =>
      heading.start > dayHeading.start && heading.start < dayHeading.end
  );
  const errors: string[] = [];
  const times = headings.filter(
    heading => heading.depth === 2 && heading.title === '時間'
  );
  const others = headings.filter(
    heading => heading.depth === 2 && heading.title === 'その他'
  );
  if (times.length !== 1)
    errors.push('「時間」の見出し2を1つだけ用意してください。');
  if (others.length > 1)
    errors.push('「その他」の見出し2は1つだけにしてください。');
  const time = times[0];
  const other = others[0];
  if (
    other &&
    headings.some(
      heading => heading.start > other.start && heading.start < other.end
    )
  ) {
    errors.push(
      `${other.line}行: 「その他」に子見出しを置くことはできません。`
    );
  }
  const normal = headings.filter(
    heading =>
      !times.some(
        section => heading.start >= section.start && heading.start < section.end
      ) &&
      !others.some(
        section => heading.start >= section.start && heading.start < section.end
      )
  );
  const bounded = normal.filter(heading => heading.depth <= maxDepth);
  const leaves = bounded.filter(
    (heading, index) =>
      !bounded[index + 1] || bounded[index + 1].depth <= heading.depth
  );
  const leafStarts = new Set(leaves.map(heading => heading.start));
  for (const heading of [...normal, ...others]) {
    const owned = parsed.entries.filter(
      entry =>
        entry.start >= heading.bodyStart &&
        entry.start < heading.bodyEnd &&
        entry.raw.trimEnd().endsWith(DURATION_MARKER)
    );
    if (owned.length > 1)
      errors.push(
        `${heading.line}行「${heading.title}」: 管理用時間行が重複しています。`
      );
    for (const entry of owned) {
      try {
        heading.duration = readDuration(entry);
      } catch (error) {
        errors.push(
          `${heading.line}行「${heading.title}」: ${errorMessage(error)}`
        );
      }
    }
    if (
      owned.length &&
      normal.includes(heading) &&
      !leafStarts.has(heading.start)
    ) {
      errors.push(
        `${heading.line}行「${heading.title}」: 配分対象外の管理用時間行を削除・移動するか、見出しの最大深さの設定を戻してください。`
      );
    }
  }
  let endMinutes: number | undefined;
  if (time && times.length === 1) {
    const values: number[] = [];
    for (const entry of parsed.entries) {
      if (
        entry.start < time.bodyStart ||
        entry.start >= time.bodyEnd ||
        entry.plain === undefined
      )
        continue;
      const value = entry.plain.trim();
      if (!/^\d+\s*:/.test(value)) continue;
      try {
        values.push(parseClock(value));
      } catch (error) {
        errors.push(`${time.line}行「時間」: ${errorMessage(error)}`);
      }
    }
    if (values.length !== 1)
      errors.push(
        `${time.line}行「時間」: 退勤時刻の箇条書きを1つだけ指定してください。`
      );
    else endMinutes = values[0];
  }
  const items = leaves.map(heading => {
    const parents: string[] = [];
    for (
      let parent = heading.parent;
      parent && parent.depth > 1;
      parent = parent.parent
    ) {
      parents.unshift(parent.title);
    }
    return {
      id: `${generation}:${heading.start}`,
      heading,
      parentPath: parents.join(' / '),
      minutes: heading.duration?.minutes ?? 0,
    };
  });
  return {
    start: dayHeading.start,
    end: dayHeading.end,
    headingEnd: dayHeading.headingEnd,
    title: dayHeading.title,
    headings,
    items,
    time,
    other,
    endMinutes,
    errors,
  };
}
