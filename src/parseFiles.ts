import type {
  GazeFrame,
  GazeResultFile,
  LoadedSession,
  PlotFrame,
  ProctoringViolation,
  ProctoringViolationInstance,
} from './types';

class OrderedEdnReader {
  private cursor = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.readValue();
    this.skipWhitespace();
    if (this.cursor !== this.text.length) throw new Error('Unexpected text in violation instances');
    return value;
  }

  private skipWhitespace(): void {
    while (/[\s,]/.test(this.text[this.cursor] ?? '')) this.cursor++;
  }

  private readValue(): unknown {
    this.skipWhitespace();
    if (this.text.startsWith('#ordered/map', this.cursor)) return this.readOrderedMap();

    const char = this.text[this.cursor];
    if (char === '[') return this.readCollection('[', ']');
    if (char === '(') return this.readCollection('(', ')');
    if (char === '"') return this.readString();
    if (char === ':') return this.readKeyword();
    return this.readAtom();
  }

  private readOrderedMap(): Record<string, unknown> {
    this.cursor += '#ordered/map'.length;
    this.skipWhitespace();
    const entries = this.readCollection('(', ')');
    const result: Record<string, unknown> = {};
    for (const entry of entries) {
      if (Array.isArray(entry) && entry.length >= 2 && typeof entry[0] === 'string') {
        result[entry[0]] = entry[1];
      }
    }
    return result;
  }

  private readCollection(open: '[' | '(', close: ']' | ')'): unknown[] {
    if (this.text[this.cursor] !== open) throw new Error('Invalid violation instances structure');
    this.cursor++;
    const values: unknown[] = [];
    while (true) {
      this.skipWhitespace();
      if (this.cursor >= this.text.length) throw new Error('Unclosed violation instances structure');
      if (this.text[this.cursor] === close) {
        this.cursor++;
        return values;
      }
      values.push(this.readValue());
    }
  }

  private readString(): string {
    const start = this.cursor++;
    let escaped = false;
    while (this.cursor < this.text.length) {
      const char = this.text[this.cursor++];
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') return JSON.parse(this.text.slice(start, this.cursor)) as string;
    }
    throw new Error('Unclosed string in violation instances');
  }

  private readKeyword(): string {
    this.cursor++;
    const start = this.cursor;
    while (this.cursor < this.text.length && !/[\s,()[\]]/.test(this.text[this.cursor])) this.cursor++;
    return this.text.slice(start, this.cursor);
  }

  private readAtom(): unknown {
    const start = this.cursor;
    while (this.cursor < this.text.length && !/[\s,()[\]]/.test(this.text[this.cursor])) this.cursor++;
    if (start === this.cursor) throw new Error('Invalid value in violation instances');
    const atom = this.text.slice(start, this.cursor);
    if (atom === 'nil') return null;
    if (atom === 'true') return true;
    if (atom === 'false') return false;
    const number = Number(atom);
    return Number.isFinite(number) ? number : atom;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parseViolationInstances(value: unknown): ProctoringViolationInstance[] {
  const parsed = typeof value === 'string' ? new OrderedEdnReader(value).parse() : value;
  if (!Array.isArray(parsed)) return [];

  return parsed.map((raw): ProctoringViolationInstance => {
    const instance = asRecord(raw);
    const time = asRecord(instance.time);
    const frames = asRecord(instance.frames);
    const snapshot = asRecord(instance.snapshot);
    const metadata = asRecord(instance.metadata);
    const confirmedFrames = Array.isArray(metadata.confirmed_frames) ? metadata.confirmed_frames : [];
    const confirmedFrame = asRecord(confirmedFrames[0]);
    const frameStartMs = asNumber(frames.start);
    const startSeconds = asNumber(time.start) ?? asNumber(snapshot.time) ?? (frameStartMs == null ? null : frameStartMs / 1000);

    return {
      confidence: asNumber(instance.conf),
      startSeconds,
      endSeconds: asNumber(time.end) ?? startSeconds,
      durationSeconds: asNumber(time.duration),
      frameName: typeof snapshot.frame === 'string'
        ? snapshot.frame
        : typeof confirmedFrame.frame_name === 'string' ? confirmedFrame.frame_name : null,
      frameTimeSeconds: asNumber(confirmedFrame.time_seconds) ?? asNumber(snapshot.time) ?? startSeconds,
      dyaw: asNumber(metadata.dyaw),
      dpitch: asNumber(metadata.dpitch),
      axis: typeof metadata.axis === 'string' ? metadata.axis : null,
    };
  });
}

export function parseViolationDump(payload: unknown): ProctoringViolation[] {
  const entries = Array.isArray(payload) ? payload : [payload];
  return entries.flatMap((entry, index) => {
    const record = asRecord(entry);
    const interviewId = record.interviewId ?? record.interview_id;
    if (typeof interviewId !== 'string') return [];

    return [{
      id: String(record._id ?? index),
      interviewId,
      type: typeof record.type === 'string' ? record.type : '',
      severity: typeof record.severity === 'string' ? record.severity : '',
      instances: parseViolationInstances(record.instances),
    }];
  });
}

function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

function parentFolder(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  parts.pop();
  return parts[parts.length - 1] ?? 'session';
}

export async function loadFromFileList(files: FileList): Promise<LoadedSession> {
  let cameraFile: File | null = null;
  let screenFile: File | null = null;
  let fallbackVideoFile: File | null = null;
  let gazeFile: File | null = null;
  const calibFiles = new Map<string, File>();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = baseName(f.name).toLowerCase();
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/').toLowerCase();

    if (name.endsWith('_final_camera.mp4')) cameraFile = f;
    if (name.endsWith('final_screen.mp4')) screenFile = f;
    if (name.endsWith('.mp4') && !fallbackVideoFile) fallbackVideoFile = f;
    if (name === 'gaze_result.json') gazeFile = f;
    if (rel.includes('/calibration/') && /\.jpe?g$/i.test(name)) {
      const point = name.replace(/\.jpe?g$/i, '');
      calibFiles.set(point, f);
    }
    if (rel.includes('calibration/') && /\.jpe?g$/i.test(name)) {
      const point = name.replace(/\.jpe?g$/i, '');
      calibFiles.set(point, f);
    }
  }

  const videoFile = cameraFile ?? screenFile ?? fallbackVideoFile;

  let gaze: GazeResultFile | null = null;
  if (gazeFile) {
    gaze = JSON.parse(await gazeFile.text()) as GazeResultFile;
  }

  const calibrationImages = new Map<string, string>();
  for (const [point, file] of calibFiles) {
    calibrationImages.set(point, URL.createObjectURL(file));
  }

  const cameraVideoUrl = cameraFile ? URL.createObjectURL(cameraFile) : null;
  const screenVideoUrl = screenFile ? URL.createObjectURL(screenFile) : null;
  const videoUrl = cameraVideoUrl ?? screenVideoUrl ?? (fallbackVideoFile ? URL.createObjectURL(fallbackVideoFile) : null);

  const label =
    gaze?.interview_id ??
    (videoFile ? parentFolder(videoFile.webkitRelativePath || videoFile.name) : 'interview');

  return {
    label,
    videoUrl,
    cameraVideoUrl,
    screenVideoUrl,
    gaze,
    calibrationImages,
  };
}

export function frameTime(fr: GazeFrame): number {
  return fr.time_seconds ?? (fr.time_ms ?? 0) / 1000;
}

export function frameAtTime(gaze: GazeResultFile | null, t: number): GazeFrame | null {
  const frames = gaze?.frames;
  if (!frames?.length) return null;
  let best = frames[0];
  let bestD = Math.abs(frameTime(best) - t);
  for (const fr of frames) {
    const d = Math.abs(frameTime(fr) - t);
    if (d < bestD) {
      best = fr;
      bestD = d;
    }
  }
  return bestD <= 1.0 ? best : null;
}

export function buildPlotFrames(gaze: GazeResultFile | null): PlotFrame[] {
  if (!gaze?.frames?.length) return [];
  const ref = gaze.calibration?.reference;
  const refYaw = ref?.yaw ?? 0;
  const refPitch = ref?.pitch ?? 0;

  return gaze.frames
    .filter((fr) => fr.gaze_yaw != null && fr.gaze_pitch != null && fr.status !== 'blink')
    .map((fr, index) => {
      const yaw = fr.gaze_yaw as number;
      const pitch = fr.gaze_pitch as number;
      const dy = fr.dyaw ?? yaw - refYaw;
      const dp = fr.dpitch ?? pitch - refPitch;
      const distance = Math.sqrt(dy * dy + dp * dp);
      const pred = fr.pred ?? null;
      return {
        index,
        t: frameTime(fr),
        yaw,
        pitch,
        pred,
        distance,
        isGazeOut: pred === 'gaze_out',
        head_yaw: fr.head_yaw,
        head_pitch: fr.head_pitch,
        head_roll: fr.head_roll,
        status: fr.status,
        reason: fr.reason,
      };
    });
}

export function modeAngle(values: number[]): number | null {
  const frequencies = new Map<number, number>();
  let mode: number | null = null;
  let highestFrequency = 0;

  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    const binStart = Math.floor(value / 4) * 4;
    const binCenter = binStart + 2;
    const frequency = (frequencies.get(binCenter) ?? 0) + 1;
    frequencies.set(binCenter, frequency);
    if (frequency > highestFrequency) {
      mode = binCenter;
      highestFrequency = frequency;
    }
  }

  return mode;
}

export const CALIB_COLORS: Record<string, string> = {
  top_left: '#e57373',
  top_center: '#f06292',
  top_right: '#ba68c8',
  left_center: '#64b5f6',
  center_1: '#4db6ac',
  center_2: '#81c784',
  right_center: '#ffb74d',
  bottom_left: '#ffd54f',
  bottom_center: '#a1887f',
  bottom_right: '#90a4ae',
};

export function calibColor(name: string, i: number): string {
  return CALIB_COLORS[name] ?? `hsl(${(i * 47) % 360} 55% 55%)`;
}

export function calibLabel(name: string): string {
  return name.replace(/_/g, ' ');
}
