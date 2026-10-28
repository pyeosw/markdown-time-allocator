/** UTF-16 offsets in the original document; end is exclusive. */
export interface SourceRange {
  start: number;
  end: number;
}

export interface DurationLine extends SourceRange {
  minutes: number;
}

export interface Heading extends SourceRange {
  depth: number;
  title: string;
  headingEnd: number;
  bodyStart: number;
  bodyEnd: number;
  line: number;
  parent?: Heading;
  duration?: DurationLine;
}

export interface WorkItem {
  id: string;
  heading: Heading;
  parentPath: string;
  minutes: number;
}

export interface DayBlock extends SourceRange {
  title: string;
  headingEnd: number;
  headings: Heading[];
  items: WorkItem[];
  time?: Heading;
  other?: Heading;
  endMinutes?: number;
  errors: string[];
}

export interface Interval {
  start: number;
  end: number;
}
export interface WorkSettings {
  startTime: number;
  amLeaveStartTime: number;
  breakTimes: Interval[];
  maxHeadingDepth: number;
}

export interface RawSettings {
  startTime: unknown;
  amLeaveStartTime: unknown;
  breakTimes: unknown;
  maxHeadingDepth: unknown;
}

export type WorkMode = 'normal' | 'amLeave';
export type SessionStatus =
  'loading' | 'ready' | 'invalid' | 'stale' | 'applying' | 'disposed';

export interface CalculationResult {
  start: number;
  end: number;
  breakMinutes: number;
  rawMinutes: number;
  workMinutes: number;
  adjustment: number;
  allocatedMinutes: number;
  remainingMinutes: number;
}

export interface SessionView {
  generation: number;
  revision: number;
  status: SessionStatus;
  title: string;
  mode: WorkMode;
  items: Array<{id: string; name: string; parentPath: string; minutes: number}>;
  calculation?: CalculationResult;
  errors: string[];
  canAdjust: boolean;
  canApply: boolean;
}

export interface TextChange extends SourceRange {
  text: string;
}
export interface EditPlan {
  edits: TextChange[];
  text: string;
}

export type ClientMessage =
  | {type: 'ready' | 'reload' | 'close'}
  | {type: 'apply'; generation: number; revision: number}
  | {
      type: 'adjust';
      generation: number;
      revision: number;
      id: string;
      direction: 1 | -1;
    }
  | {
      type: 'changeWorkMode';
      generation: number;
      revision: number;
      mode: WorkMode;
    };
