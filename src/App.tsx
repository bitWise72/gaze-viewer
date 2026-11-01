import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildPlotFrames, calibColor, calibLabel, frameAtTime, frameTime, loadFromFileList } from './parseFiles';
import {
  drawDistancePlot,
  drawYawPitchPlot,
  downloadCanvas,
  hitTestDistance,
  hitTestScatter,
  type HoverHit,
  type LineDrawOptions,
  type ScatterDrawOptions,
} from './plotCanvas';
import type { GazeFrame, LoadedSession } from './types';
import './styles.css';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

function FrameStats({ frame }: { frame: GazeFrame | null }) {
  if (!frame) {
    return (
      <div className="frame-stats">
        <span className="muted">No gaze record within 1.0s of this timestamp</span>
      </div>
    );
  }

  return (
    <div className="frame-stats">
      <span>
        <b>t</b> {formatTime(frameTime(frame))} ({frameTime(frame).toFixed(2)}s)
      </span>
      {frame.frame_name && <span><b>frame</b> {frame.frame_name}</span>}
      <span>
        <b>gaze</b> y={fmt(frame.gaze_yaw)} p={fmt(frame.gaze_pitch)}
      </span>
      <span>
        <b>head</b> y={fmt(frame.head_yaw)} p={fmt(frame.head_pitch)} r={fmt(frame.head_roll)}
      </span>
      <span>
        <b>status</b> {frame.status ?? '—'}
      </span>
      {frame.pred != null && <span><b>pred</b> {frame.pred}</span>}
      {frame.reason != null && <span><b>reason</b> {frame.reason}</span>}
      {(frame.dyaw != null || frame.dpitch != null) && (
        <span><b>delta</b> y={fmt(frame.dyaw)} p={fmt(frame.dpitch)}</span>
      )}
      {frame.gaze_yaw == null && frame.gaze_pitch == null && (
        <span className="muted">Gaze yaw/pitch unavailable</span>
      )}
    </div>
  );
}

interface CalibPreview {
  name: string;
  label: string;
  imgUrl: string;
  gaze_yaw?: number | null;
  gaze_pitch?: number | null;
  status?: string | null;
  color: string;
}

export default function App() {
  const [session, setSession] = useState<LoadedSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [simPlaying, setSimPlaying] = useState(false);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [calibPreview, setCalibPreview] = useState<CalibPreview | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const scatterWrapRef = useRef<HTMLDivElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLCanvasElement>(null);
  const plotWrapRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);

  const plotFrames = useMemo(() => buildPlotFrames(session?.gaze ?? null), [session?.gaze]);
  const calibPoints = session?.gaze?.calibration?.points ?? [];
  const modeYaw = session?.gaze?.calibration?.mode?.yaw ?? null;
  const modePitch = session?.gaze?.calibration?.mode?.pitch ?? null;
  const timelineDuration = videoDuration || plotFrames.at(-1)?.t || 0;

  const hasCalibImages = (session?.calibrationImages.size ?? 0) > 0;
  const hasCalibMeta = calibPoints.length > 0;

  const liveFrame = useMemo(
    () => frameAtTime(session?.gaze ?? null, currentTime),
    [session?.gaze, currentTime]
  );

  const scatterOpts = useCallback((): ScatterDrawOptions | null => {
    const wrap = scatterWrapRef.current;
    if (!wrap) return null;
    const w = Math.max(280, wrap.clientWidth);
    const h = Math.max(320, wrap.clientHeight);
    return {
      frames: plotFrames,
      calibPoints,
      modeYaw,
      modePitch,
      currentTime,
      width: w,
      height: h,
      title: 'Yaw / pitch',
    };
  }, [plotFrames, calibPoints, modeYaw, modePitch, currentTime]);

  const lineOpts = useCallback((): LineDrawOptions | null => {
    const col = leftColRef.current;
    if (!col) return null;
    return {
      frames: plotFrames,
      currentTime,
      width: col.clientWidth - 24,
      height: 150,
      title: 'Distance from reference',
    };
  }, [plotFrames, currentTime]);

  const redraw = useCallback(() => {
    const scatter = scatterRef.current;
    const line = lineRef.current;
    const sOpts = scatterOpts();
    const lOpts = lineOpts();
    if (scatter && sOpts) drawYawPitchPlot(scatter, sOpts);
    if (line && lOpts) drawDistancePlot(line, lOpts);
  }, [scatterOpts, lineOpts]);

  useEffect(() => {
    redraw();
    const ro = new ResizeObserver(() => redraw());
    if (scatterWrapRef.current) ro.observe(scatterWrapRef.current);
    if (plotWrapRef.current) ro.observe(plotWrapRef.current);
    if (leftColRef.current) ro.observe(leftColRef.current);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(() => {
    if (!simPlaying || session?.videoUrl) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setCurrentTime((t) => {
        const next = t + dt * playbackRate;
        if (next >= timelineDuration) {
          setSimPlaying(false);
          return timelineDuration;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [simPlaying, session?.videoUrl, playbackRate, timelineDuration]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = playbackRate;
  }, [playbackRate, session?.videoUrl]);

  const calibPreviewItems = useMemo((): CalibPreview[] => {
    if (!session || !hasCalibImages) return [];
    return calibPoints
      .filter((p) => session.calibrationImages.has(p.name))
      .map((p) => {
        const i = calibPoints.findIndex((c) => c.name === p.name);
        return {
          name: p.name,
          label: calibLabel(p.name),
          imgUrl: session.calibrationImages.get(p.name)!,
          gaze_yaw: p.gaze_yaw,
          gaze_pitch: p.gaze_pitch,
          status: p.status,
          color: calibColor(p.name, i >= 0 ? i : 0),
        };
      });
  }, [session, calibPoints, hasCalibImages]);

  const stepCalibPreview = useCallback(
    (delta: number) => {
      setCalibPreview((current) => {
        if (!current || calibPreviewItems.length < 2) return current;
        const idx = calibPreviewItems.findIndex((x) => x.name === current.name);
        if (idx < 0) return current;
        const next = (idx + delta + calibPreviewItems.length) % calibPreviewItems.length;
        return calibPreviewItems[next];
      });
    },
    [calibPreviewItems]
  );

  useEffect(() => {
    if (!calibPreview) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCalibPreview(null);
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepCalibPreview(-1);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepCalibPreview(1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [calibPreview, stepCalibPreview]);

  const seekToTime = (t: number) => {
    const v = videoRef.current;
    if (v && session?.videoUrl) {
      v.pause();
      v.currentTime = t;
    }
    setCurrentTime(t);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setLoadError(null);
    try {
      if (session?.videoUrl) URL.revokeObjectURL(session.videoUrl);
      session?.calibrationImages.forEach((u) => URL.revokeObjectURL(u));
      setSession(await loadFromFileList(files));
      setCurrentTime(0);
      setCalibPreview(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (v) setCurrentTime(v.currentTime);
  };

  const onSeek = (value: number) => {
    const v = videoRef.current;
    if (v) {
      v.currentTime = value;
      setCurrentTime(value);
    } else {
      setCurrentTime(value);
    }
  };

  const onScatterClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sOpts = scatterOpts();
    const canvas = scatterRef.current;
    if (!sOpts || !canvas) return;
    const hit = hitTestScatter(sOpts, e.clientX, e.clientY, canvas);
    if (hit?.kind === 'frame') seekToTime(hit.frame.t);
  };

  const onLineClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const lOpts = lineOpts();
    const canvas = lineRef.current;
    if (!lOpts || !canvas) return;
    const hit = hitTestDistance(lOpts, e.clientX, e.clientY, canvas);
    if (hit?.kind === 'frame') seekToTime(hit.frame.t);
  };

  const hoverText = (hit: HoverHit): string => {
    if (!hit) return '';
    if (hit.kind === 'calib') {
      return `${calibLabel(hit.name)}\nyaw ${hit.yaw.toFixed(2)}° · pitch ${hit.pitch.toFixed(2)}°`;
    }
    const f = hit.frame;
    return `t ${formatTime(f.t)} (${f.t.toFixed(1)}s)\nyaw ${f.yaw.toFixed(2)}° · pitch ${f.pitch.toFixed(2)}°${f.pred ? `\n${f.pred}` : ''}`;
  };

  const onScatterMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const sOpts = scatterOpts();
    const canvas = scatterRef.current;
    if (!sOpts || !canvas) return;
    const hit = hitTestScatter(sOpts, e.clientX, e.clientY, canvas);
    if (hit) setTooltip({ x: e.clientX + 12, y: e.clientY + 12, text: hoverText(hit) });
    else setTooltip(null);
  };

  const onLineMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const lOpts = lineOpts();
    const canvas = lineRef.current;
    if (!lOpts || !canvas) return;
    const hit = hitTestDistance(lOpts, e.clientX, e.clientY, canvas);
    if (hit) setTooltip({ x: e.clientX + 12, y: e.clientY + 12, text: hoverText(hit) });
    else setTooltip(null);
  };

  const calibGalleryCards = useMemo(() => {
    if (!hasCalibImages) return null;
    return calibPoints
      .filter((p) => session?.calibrationImages.has(p.name))
      .map((p, i) => {
        const img = session!.calibrationImages.get(p.name)!;
        return (
          <button
            key={p.name}
            type="button"
            className="calib-card"
            onClick={() => {
              const idx = calibPoints.findIndex((c) => c.name === p.name);
              setCalibPreview({
                name: p.name,
                label: calibLabel(p.name),
                imgUrl: img,
                gaze_yaw: p.gaze_yaw,
                gaze_pitch: p.gaze_pitch,
                status: p.status,
                color: calibColor(p.name, idx >= 0 ? idx : i),
              });
            }}
          >
            <img src={img} alt={p.name} />
            <span className="calib-card-caption">
              <strong>{calibLabel(p.name)}</strong>
              <span>
                y={p.gaze_yaw?.toFixed(1) ?? '—'} p={p.gaze_pitch?.toFixed(1) ?? '—'}
              </span>
              <span className="swatch" style={{ background: calibColor(p.name, i) }} />
            </span>
          </button>
        );
      });
  }, [calibPoints, session, hasCalibImages]);

  return (
    <div className="app">
      <header className="header">
        <h1>Gaze viewer</h1>
        <div className="loaders">
          <label className="btn">
            Open folder
            <input
              type="file"
              multiple
              // @ts-expect-error webkitdirectory
              webkitdirectory=""
              directory=""
              hidden
              onChange={(e) => onFiles(e.target.files)}
            />
          </label>
          <label className="btn secondary">
            Open files
            <input type="file" multiple hidden accept=".mp4,.json,.jpg,.jpeg" onChange={(e) => onFiles(e.target.files)} />
          </label>
        </div>
      </header>

      {loadError && <p className="error">{loadError}</p>}
      {session && <p className="session-label">{session.label}</p>}

      {!session && <div className="empty">Open folder or files to begin.</div>}

      {session && (
        <div className="workspace">
          <div className="main-grid">
            <div className="left-col" ref={leftColRef}>
              <section className="video-pane">
                {session.videoUrl ? (
                  <>
                    <div className="video-wrap">
                      <video
                        ref={videoRef}
                        src={session.videoUrl}
                        controls
                        onTimeUpdate={onTimeUpdate}
                        onSeeked={onTimeUpdate}
                        onLoadedMetadata={() => {
                          const v = videoRef.current;
                          if (v) setVideoDuration(v.duration);
                          onTimeUpdate();
                        }}
                      />
                    </div>
                    <div className="video-controls">
                      <label>
                        Speed
                        <select value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))}>
                          {SPEEDS.map((s) => (
                            <option key={s} value={s}>
                              {s}x
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="seek">
                        <input
                          type="range"
                          min={0}
                          max={timelineDuration || 1}
                          step={0.1}
                          value={Math.min(currentTime, timelineDuration || 1)}
                          onChange={(e) => onSeek(Number(e.target.value))}
                        />
                      </label>
                      <span className="time-readout">
                        {formatTime(currentTime)} / {formatTime(timelineDuration)}
                      </span>
                    </div>
                    <FrameStats frame={liveFrame} />
                  </>
                ) : (
                  <div className="video-placeholder">
                    <div className="video-controls">
                      <button type="button" className="btn small" onClick={() => setSimPlaying((p) => !p)}>
                        {simPlaying ? 'Pause' : 'Play'}
                      </button>
                      <label className="seek">
                        <input
                          type="range"
                          min={0}
                          max={timelineDuration || 1}
                          step={0.1}
                          value={Math.min(currentTime, timelineDuration || 1)}
                          onChange={(e) => setCurrentTime(Number(e.target.value))}
                        />
                      </label>
                      <span className="time-readout">{formatTime(currentTime)}</span>
                    </div>
                    <FrameStats frame={liveFrame} />
                  </div>
                )}
                <canvas
                  ref={lineRef}
                  className="plot distance-plot"
                  onClick={onLineClick}
                  onMouseMove={onLineMove}
                  onMouseLeave={() => setTooltip(null)}
                />
              </section>
            </div>

            <section className="plots yaw-pane" ref={plotWrapRef}>
              <div className="plot-toolbar">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => scatterRef.current && downloadCanvas(scatterRef.current, `yaw-pitch-${session.label}.png`)}
                >
                  Download
                </button>
              </div>
              <div className="scatter-wrap" ref={scatterWrapRef}>
                <canvas
                  ref={scatterRef}
                  className="plot scatter-plot"
                  onClick={onScatterClick}
                  onMouseMove={onScatterMove}
                  onMouseLeave={() => setTooltip(null)}
                />
              </div>
              <div className="legend legend-wrap">
                <span>
                  <i className="dot grey" /> trace
                </span>
                <span>
                  <i className="dot red" /> gaze out
                </span>
                {(modeYaw != null || modePitch != null) && (
                  <span>
                    <i className="dash purple" /> mode yaw / pitch
                  </span>
                )}
                {calibPoints.map((c, i) => (
                  <span key={c.name}>
                    <i className="dot" style={{ background: calibColor(c.name, i) }} /> {calibLabel(c.name)}
                  </span>
                ))}
              </div>
            </section>
          </div>

          <section className="gallery gallery-scroll">
            <h2>Calibration</h2>
            {!hasCalibMeta && !hasCalibImages && <p className="gallery-empty">Calibration not available.</p>}
            {hasCalibMeta && !hasCalibImages && (
              <p className="gallery-empty">Calibration images not loaded.</p>
            )}
            {hasCalibImages && calibGalleryCards && calibGalleryCards.length > 0 && (
              <div className="gallery-grid">{calibGalleryCards}</div>
            )}
          </section>
        </div>
      )}

      {tooltip && (
        <div className="plot-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          {tooltip.text.split('\n').map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      )}

      {calibPreview && (
        <div
          className="calib-modal-backdrop"
          onClick={() => setCalibPreview(null)}
          role="presentation"
        >
          <div
            className="calib-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="calib-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className="calib-modal-close" onClick={() => setCalibPreview(null)} aria-label="Close">
              ×
            </button>
            <p id="calib-modal-title" className="calib-modal-title">
              {calibPreview.label}
              {calibPreviewItems.length > 1 && (
                <span className="calib-modal-counter">
                  {calibPreviewItems.findIndex((x) => x.name === calibPreview.name) + 1} / {calibPreviewItems.length}
                </span>
              )}
            </p>
            <div className="calib-modal-carousel">
              {calibPreviewItems.length > 1 && (
                <button
                  type="button"
                  className="calib-modal-nav"
                  aria-label="Previous calibration frame"
                  onClick={() => stepCalibPreview(-1)}
                >
                  ←
                </button>
              )}
              <div className="calib-modal-image-wrap">
                <img src={calibPreview.imgUrl} alt={calibPreview.label} />
              </div>
              {calibPreviewItems.length > 1 && (
                <button
                  type="button"
                  className="calib-modal-nav"
                  aria-label="Next calibration frame"
                  onClick={() => stepCalibPreview(1)}
                >
                  →
                </button>
              )}
            </div>
            <dl className="calib-modal-meta">
              <div>
                <dt>gaze yaw</dt>
                <dd>{fmtDeg(calibPreview.gaze_yaw)}</dd>
              </div>
              <div>
                <dt>gaze pitch</dt>
                <dd>{fmtDeg(calibPreview.gaze_pitch)}</dd>
              </div>
              {calibPreview.status != null && calibPreview.status !== '' && (
                <div>
                  <dt>status</dt>
                  <dd>{calibPreview.status}</dd>
                </div>
              )}
            </dl>
            <span className="calib-modal-swatch" style={{ background: calibPreview.color }} title="Plot color" />
          </div>
        </div>
      )}
    </div>
  );
}

function fmtDeg(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(2)}°`;
}

function fmt(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${v.toFixed(1)}°`;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
