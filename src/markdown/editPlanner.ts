import {DayBlock, EditPlan, Heading, TextChange} from '../domain/models';
import {formatHours} from '../domain/timeCalculator';

import {DURATION_MARKER, parseDay, parseDocument} from './parser';

/** Applies disjoint source-coordinate edits and rejects ambiguous overlaps. */
export function applyChanges(
  text: string,
  edits: readonly TextChange[]
): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let previousEnd = 0;
  let previousStart = -1;
  for (const edit of sorted) {
    if (
      edit.start < previousEnd ||
      edit.start === previousStart ||
      edit.end < edit.start ||
      edit.end > text.length ||
      edit.start < 0
    )
      throw new Error('編集範囲が重複または不正です。');
    previousEnd = edit.end;
    previousStart = edit.start;
  }
  let output = text;
  for (const edit of sorted.reverse())
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  return output;
}

/** Builds a replacement or an insertion immediately after the complete heading. */
function durationEdit(
  text: string,
  heading: Heading,
  minutes: number,
  eol: string
): TextChange | undefined {
  const row = `- 作業時間: ${formatHours(minutes)} ${DURATION_MARKER}`;
  if (heading.duration) {
    if (text.slice(heading.duration.start, heading.duration.end) === row)
      return undefined;
    return {
      start: heading.duration.start,
      end: heading.duration.end,
      text: row,
    };
  }
  return {
    start: heading.headingEnd,
    end: heading.headingEnd,
    text: `${eol}${eol}${row}${eol}`,
  };
}

/** Ensures moved or new sections remain separate Markdown blocks. */
function sectionInsertion(
  text: string,
  at: number,
  section: string,
  eol: string
): string {
  const prefix = text.slice(0, at);
  const before = prefix.endsWith(eol + eol)
    ? ''
    : prefix.endsWith(eol)
      ? eol
      : eol + eol;
  const after = section.endsWith(eol + eol)
    ? ''
    : section.endsWith(eol)
      ? eol
      : eol + eol;
  return before + section + after;
}

/** Plans minimal duration edits and places Other immediately before the time section. */
export function planEdits(
  text: string,
  day: DayBlock,
  allocations: readonly number[],
  remaining: number,
  maxDepth: number
): EditPlan {
  if (day.errors.length || !day.time)
    throw new Error('Markdownのエラーを修正してください。');
  if (
    allocations.length !== day.items.length ||
    [...allocations, remaining].some(
      value => !Number.isSafeInteger(value) || value < 0 || value % 15 !== 0
    )
  ) {
    throw new Error('配分は0以上の0.25h単位で指定してください。');
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const edits: TextChange[] = [];
  for (let i = 0; i < day.items.length; i++) {
    const edit = durationEdit(text, day.items[i].heading, allocations[i], eol);
    if (edit) edits.push(edit);
  }
  const other = day.other;
  if (other) {
    const edit = durationEdit(text, other, remaining, eol);
    if (other.end === day.time.start) {
      if (edit) edits.push(edit);
    } else {
      const section = text.slice(other.start, other.end);
      const moved = edit
        ? applyChanges(section, [
            {
              start: edit.start - other.start,
              end: edit.end - other.start,
              text: edit.text,
            },
          ])
        : section;
      edits.push({start: other.start, end: other.end, text: ''});
      edits.push({
        start: day.time.start,
        end: day.time.start,
        text: sectionInsertion(text, day.time.start, moved, eol),
      });
    }
  } else if (remaining > 0) {
    const section = `## その他${eol}${eol}- 作業時間: ${formatHours(remaining)} ${DURATION_MARKER}${eol}${eol}`;
    edits.push({
      start: day.time.start,
      end: day.time.start,
      text: sectionInsertion(text, day.time.start, section, eol),
    });
  }
  if (edits.some(edit => edit.start < day.start || edit.end > day.end)) {
    throw new Error('編集範囲が対象の日を超えています。');
  }
  const output = applyChanges(text, edits);
  const reparsed = parseDay(output, day.start, maxDepth);
  const h2 = reparsed.headings.filter(heading => heading.depth === 2);
  const timeIndex = h2.indexOf(reparsed.time as Heading);
  if (
    reparsed.errors.length ||
    reparsed.items.length !== allocations.length ||
    reparsed.items.some((item, index) => item.minutes !== allocations[index]) ||
    ((other || remaining > 0) &&
      (!reparsed.other ||
        reparsed.other.duration?.minutes !== remaining ||
        h2[timeIndex - 1] !== reparsed.other))
  ) {
    throw new Error(
      '出力後の見出し・管理行の構造が不正です。Markdownの構文を確認してください。'
    );
  }
  const originalHeadings = parseDocument(text).headings.filter(
    heading => heading.start !== other?.start
  );
  const outputHeadings = parseDocument(output).headings.filter(
    heading => heading.start !== reparsed.other?.start
  );
  if (
    originalHeadings.length !== outputHeadings.length ||
    originalHeadings.some((heading, index) => {
      const next = outputHeadings[index];
      return (
        heading.depth !== next.depth ||
        heading.title !== next.title ||
        text.slice(heading.start, heading.headingEnd) !==
          output.slice(next.start, next.headingEnd)
      );
    })
  )
    throw new Error(
      '出力により既存の見出し構造が変化します。Markdownの構文を確認してください。'
    );
  return {edits: output === text ? [] : edits, text: output};
}
