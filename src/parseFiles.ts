import type { GazeFrame, GazeResultFile, LoadedSession, PlotFrame } from './types';

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
  let videoFile: File | null = null;
  let gazeFile: File | null = null;
  const calibFiles = new Map<string, File>();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = baseName(f.name).toLowerCase();
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/').toLowerCase();

    if (name.endsWith('_final_camera.mp4') || (name.endsWith('.mp4') && !videoFile)) {
      if (name.includes('final_camera') || !videoFile) videoFile = f;
    }
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

  if (!videoFile) {
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (/\.mp4$/i.test(f.name)) {
        videoFile = f;
        break;
      }
    }
  }

  let gaze: GazeResultFile | null = null;
  if (gazeFile) {
    gaze = JSON.parse(await gazeFile.text()) as GazeResultFile;
  }

  const calibrationImages = new Map<string, string>();
  for (const [point, file] of calibFiles) {
    calibrationImages.set(point, URL.createObjectURL(file));
  }

  const label =
    gaze?.interview_id ??
    (videoFile ? parentFolder(videoFile.webkitRelativePath || videoFile.name) : 'interview');

  return {
    label,
    videoUrl: videoFile ? URL.createObjectURL(videoFile) : null,
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
