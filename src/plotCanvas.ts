import type { GazeCalibrationPoint, PlotFrame } from './types';
import { calibColor } from './parseFiles';

export interface ScatterDrawOptions {
  frames: PlotFrame[];
  calibPoints: GazeCalibrationPoint[];
  modeYaw: number | null;
  modePitch: number | null;
  currentTime: number;
  width: number;
  height: number;
  title: string;
}

export interface LineDrawOptions {
  frames: PlotFrame[];
  currentTime: number;
  width: number;
  height: number;
  title: string;
}

export type HoverHit =
  | { kind: 'frame'; frame: PlotFrame }
  | { kind: 'calib'; name: string; yaw: number; pitch: number }
  | null;

const pad = 40;
const topExtra = 14;

/** Map screen coords to plot logical coords (matches draw buffer when CSS scales the canvas). */
function pointerToPlot(
  canvas: HTMLCanvasElement,
  plotWidth: number,
  plotHeight: number,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { x: 0, y: 0 };
  }
  return {
    x: ((clientX - rect.left) / rect.width) * plotWidth,
    y: ((clientY - rect.top) / rect.height) * plotHeight,
  };
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function computeBounds(
  frames: PlotFrame[],
  calib: GazeCalibrationPoint[],
  modeYaw: number | null,
  modePitch: number | null
) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const f of frames) {
    xs.push(f.yaw);
    ys.push(f.pitch);
  }
  for (const c of calib) {
    if (c.gaze_yaw != null) xs.push(c.gaze_yaw);
    if (c.gaze_pitch != null) ys.push(c.gaze_pitch);
  }
  if (modeYaw != null) xs.push(modeYaw);
  if (modePitch != null) ys.push(modePitch);
  if (!xs.length) return { minX: -10, maxX: 10, minY: -10, maxY: 10 };
  const padX = (Math.max(...xs) - Math.min(...xs)) * 0.1 || 5;
  const padY = (Math.max(...ys) - Math.min(...ys)) * 0.1 || 5;
  return {
    minX: Math.min(...xs) - padX,
    maxX: Math.max(...xs) + padX,
    minY: Math.min(...ys) - padY,
    maxY: Math.max(...ys) + padY,
  };
}

function scatterTransform(w: number, h: number, bounds: ReturnType<typeof computeBounds>) {
  const plotW = w - pad * 2;
  const plotH = h - pad * 2 - topExtra;
  const toX = (yaw: number) => pad + ((yaw - bounds.minX) / (bounds.maxX - bounds.minX)) * plotW;
  const toY = (pitch: number) => pad + topExtra + plotH - ((pitch - bounds.minY) / (bounds.maxY - bounds.minY)) * plotH;
  return { plotW, plotH, toX, toY };
}

export function drawYawPitchPlot(canvas: HTMLCanvasElement, opts: ScatterDrawOptions): void {
  const dpr = window.devicePixelRatio || 1;
  const w = opts.width;
  const h = opts.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#fafbfd';
  ctx.fillRect(0, 0, w, h);

  const bounds = computeBounds(opts.frames, opts.calibPoints, opts.modeYaw, opts.modePitch);
  const { plotW, plotH, toX, toY } = scatterTransform(w, h, bounds);

  ctx.strokeStyle = '#d0d7e2';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, pad + topExtra);
  ctx.lineTo(pad, pad + topExtra + plotH);
  ctx.lineTo(pad + plotW, pad + topExtra + plotH);
  ctx.stroke();

  ctx.fillStyle = '#5c6b7a';
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillText('Yaw →', pad + plotW / 2 - 18, h - 4);
  ctx.save();
  ctx.translate(10, pad + topExtra + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Pitch →', -22, 0);
  ctx.restore();

  ctx.fillStyle = '#334155';
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.fillText(opts.title, pad, 12);
  ctx.fillStyle = '#64748b';
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillText(formatTime(opts.currentTime), w - pad - 40, 12);

  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = '#7c3aed';
  ctx.lineWidth = 1.5;
  if (opts.modeYaw != null) {
    const mx = toX(opts.modeYaw);
    ctx.beginPath();
    ctx.moveTo(mx, pad + topExtra);
    ctx.lineTo(mx, pad + topExtra + plotH);
    ctx.stroke();
    ctx.fillStyle = '#7c3aed';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(`mode yaw ${opts.modeYaw.toFixed(1)}°`, mx + 3, pad + topExtra + 10);
  }
  if (opts.modePitch != null) {
    const my = toY(opts.modePitch);
    ctx.beginPath();
    ctx.moveTo(pad, my);
    ctx.lineTo(pad + plotW, my);
    ctx.stroke();
    ctx.fillStyle = '#7c3aed';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(`mode pitch ${opts.modePitch.toFixed(1)}°`, pad + 4, my - 4);
  }
  ctx.setLineDash([]);

  const visible = opts.frames.filter((f) => f.t <= opts.currentTime + 0.05);

  for (const f of visible) {
    const x = toX(f.yaw);
    const y = toY(f.pitch);
    const fill = f.isGazeOut ? '#ef4444' : '#64748b';
    ctx.beginPath();
    ctx.arc(x, y, f.isGazeOut ? 4.5 : 3.5, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  }

  opts.calibPoints.forEach((c, i) => {
    if (c.gaze_yaw == null || c.gaze_pitch == null) return;
    const x = toX(c.gaze_yaw);
    const y = toY(c.gaze_pitch);
    const color = calibColor(c.name, i);
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  const currentFrame = [...visible].reverse().find((f) => f.t <= opts.currentTime);
  if (currentFrame) {
    const cx = toX(currentFrame.yaw);
    const cy = toY(currentFrame.pitch);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, pad + topExtra);
    ctx.lineTo(cx, pad + topExtra + plotH);
    ctx.moveTo(pad, cy);
    ctx.lineTo(pad + plotW, cy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export function hitTestScatter(
  opts: ScatterDrawOptions,
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement
): HoverHit {
  const { x, y } = pointerToPlot(canvas, opts.width, opts.height, clientX, clientY);
  const bounds = computeBounds(opts.frames, opts.calibPoints, opts.modeYaw, opts.modePitch);
  const { toX, toY } = scatterTransform(opts.width, opts.height, bounds);
  const visible = opts.frames.filter((f) => f.t <= opts.currentTime + 0.05);
  const r = 11;

  for (const c of opts.calibPoints) {
    if (c.gaze_yaw == null || c.gaze_pitch == null) continue;
    const dx = toX(c.gaze_yaw) - x;
    const dy = toY(c.gaze_pitch) - y;
    if (Math.sqrt(dx * dx + dy * dy) <= r + 2) {
      return { kind: 'calib', name: c.name, yaw: c.gaze_yaw, pitch: c.gaze_pitch };
    }
  }

  let best: { frame: PlotFrame; d: number } | null = null;
  for (const f of visible) {
    const dx = toX(f.yaw) - x;
    const dy = toY(f.pitch) - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r && (!best || d < best.d)) best = { frame: f, d };
  }
  return best ? { kind: 'frame', frame: best.frame } : null;
}

function lineTransform(w: number, h: number, maxT: number, maxD: number) {
  const left = pad + 12;
  const top = pad + topExtra;
  const bottom = 32;
  const plotW = w - left - pad;
  const plotH = h - top - bottom;
  const toX = (t: number) => left + (t / maxT) * plotW;
  const toY = (d: number) => h - bottom - (d / maxD) * plotH;
  return { plotW, plotH, toX, toY };
}

function formatAxisTime(seconds: number, maxTime: number): string {
  if (maxTime < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export function drawDistancePlot(canvas: HTMLCanvasElement, opts: LineDrawOptions): void {
  const dpr = window.devicePixelRatio || 1;
  const w = opts.width;
  const h = opts.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.fillStyle = '#fafbfd';
  ctx.fillRect(0, 0, w, h);

  const frames = opts.frames;
  if (!frames.length) {
    ctx.fillStyle = '#64748b';
    ctx.fillText('No frame data', pad, h / 2);
    return;
  }

  const maxT = Math.max(...frames.map((f) => f.t), 1);
  const visible = frames.filter((f) => f.t <= opts.currentTime + 0.05);
  const maxD = Math.max(...frames.map((f) => f.distance), 1);
  const { plotH, toX, toY } = lineTransform(w, h, maxT, maxD);
  const left = pad + 12;
  const plotW = w - left - pad;
  const bottom = h - 32;

  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 1;
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = '#64748b';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = (maxD * i) / 4;
    const y = toY(value);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + plotW, y);
    ctx.stroke();
    ctx.fillText(value.toFixed(1), left - 6, y);
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (let i = 0; i <= 4; i++) {
    const value = (maxT * i) / 4;
    const x = toX(value);
    ctx.beginPath();
    ctx.moveTo(x, pad + topExtra);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.fillText(formatAxisTime(value, maxT), x, bottom + 4);
  }

  ctx.strokeStyle = '#cbd5e1';
  ctx.beginPath();
  ctx.moveTo(left, pad + topExtra);
  ctx.lineTo(left, bottom);
  ctx.lineTo(left + plotW, bottom);
  ctx.stroke();

  ctx.fillStyle = '#334155';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(opts.title, pad, 12);

  ctx.fillStyle = '#475569';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('Time', left + plotW / 2, h - 1);
  ctx.save();
  ctx.translate(10, pad + topExtra + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Distance (°)', 0, 0);
  ctx.restore();

  if (visible.length >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 1.5;
    visible.forEach((f, i) => {
      const x = toX(f.t);
      const y = toY(f.distance);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  for (const f of visible) {
    ctx.beginPath();
    ctx.arc(toX(f.t), toY(f.distance), f.isGazeOut ? 3.5 : 2.5, 0, Math.PI * 2);
    ctx.fillStyle = f.isGazeOut ? '#ef4444' : '#94a3b8';
    ctx.fill();
  }

  const mx = toX(Math.min(opts.currentTime, maxT));
  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(mx, pad + topExtra);
  ctx.lineTo(mx, pad + topExtra + plotH);
  ctx.stroke();
  ctx.setLineDash([]);
}

export function hitTestDistance(
  opts: LineDrawOptions,
  clientX: number,
  clientY: number,
  canvas: HTMLCanvasElement
): HoverHit {
  const { x, y } = pointerToPlot(canvas, opts.width, opts.height, clientX, clientY);
  const frames = opts.frames;
  if (!frames.length) return null;
  const maxT = Math.max(...frames.map((f) => f.t), 1);
  const maxD = Math.max(...frames.map((f) => f.distance), 1);
  const { toX, toY } = lineTransform(opts.width, opts.height, maxT, maxD);
  const visible = frames.filter((f) => f.t <= opts.currentTime + 0.05);
  const r = 9;
  let best: { frame: PlotFrame; d: number } | null = null;
  for (const f of visible) {
    const dx = toX(f.t) - x;
    const dy = toY(f.distance) - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= r && (!best || d < best.d)) best = { frame: f, d };
  }
  return best ? { kind: 'frame', frame: best.frame } : null;
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  const link = document.createElement('a');
  link.download = filename;
  link.href = canvas.toDataURL('image/png');
  link.click();
}
