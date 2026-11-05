export interface GazeCalibrationPoint {
  name: string;
  status?: string | null;
  reason?: string | null;
  gaze_yaw?: number | null;
  gaze_pitch?: number | null;
  head_yaw?: number | null;
  head_pitch?: number | null;
  head_roll?: number | null;
  method?: string | null;
}

export interface GazeReference {
  yaw: number;
  pitch: number;
}

export interface GazeLimits {
  yaw: number;
  pitch: number;
}

export interface GazeFrame {
  frame_name?: string;
  time_seconds: number;
  time_ms?: number;
  gaze_yaw?: number | null;
  gaze_pitch?: number | null;
  head_yaw?: number | null;
  head_pitch?: number | null;
  head_roll?: number | null;
  pred?: string | null;
  status?: string | null;
  reason?: string | null;
  dyaw?: number | null;
  dpitch?: number | null;
}

export interface GazeResultFile {
  interview_id?: string;
  client_id?: string;
  calibration?: {
    method?: string | null;
    reference?: GazeReference | null;
    mode?: GazeReference | null;
    limits?: GazeLimits | null;
    points?: GazeCalibrationPoint[];
  };
  frames?: GazeFrame[];
}

export interface LoadedSession {
  label: string;
  videoUrl: string | null;
  cameraVideoUrl: string | null;
  screenVideoUrl: string | null;
  gaze: GazeResultFile | null;
  calibrationImages: Map<string, string>;
}

export interface PlotFrame {
  index: number;
  t: number;
  yaw: number;
  pitch: number;
  pred: string | null;
  distance: number;
  isGazeOut: boolean;
  head_yaw?: number | null;
  head_pitch?: number | null;
  head_roll?: number | null;
  status?: string | null;
  reason?: string | null;
}

export interface ProctoringViolationInstance {
  confidence: number | null;
  startSeconds: number | null;
  endSeconds: number | null;
  durationSeconds: number | null;
  frameName: string | null;
  frameTimeSeconds: number | null;
  dyaw: number | null;
  dpitch: number | null;
  referenceYaw: number | null;
  referencePitch: number | null;
  axis: string | null;
}

export interface ProctoringViolation {
  id: string;
  interviewId: string;
  type: string;
  severity: string;
  instances: ProctoringViolationInstance[];
}

