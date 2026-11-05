import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPlotFrames,
  calibColor,
  calibLabel,
  frameAtTime,
  frameTime,
  loadFromFileList,
  parseViolationDump,
} from './parseFiles';
import {
  drawDistancePlot,
  drawYawPitchPlot,
  hitTestDistance,
  hitTestScatter,
  type HoverHit,
  type LineDrawOptions,
  type ScatterDrawOptions,
} from './plotCanvas';
import type {
  GazeFrame,
  GazeLimits,
  LoadedSession,
  PlotFrame,
  ProctoringViolation,
} from './types';
import './styles.css';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
type ReviewStatus = 'correct' | 'incorrect' | 'unsure';

interface AnnotationPopup {
  frame: PlotFrame;
  x: number;
  y: number;
}

interface UploadedViolationDump {
  fileName: string;
  records: ProctoringViolation[];
}

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, header: string[], rows: (string | number | null | undefined)[][]) {
  const content = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function reviewProgress(statuses: object) {
  const decided = (Object.values(statuses) as unknown[]).filter(
    (status): status is Exclude<ReviewStatus, 'unsure'> => status === 'correct' || status === 'incorrect'
  );
  const correct = decided.filter((status) => status === 'correct').length;
  return {
    correct,
    decided: decided.length,
    percentage: decided.length ? Math.round((correct / decided.length) * 100) : null,
  };
}

function FrameStats({ frame, limits }: { frame: GazeFrame | null; limits: GazeLimits | null }) {
  return (
    <div className="frame-stats">
      {frame ? (
        <>
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
        </>
      ) : (
        <span className="muted">No gaze record within 1.0s of this timestamp</span>
      )}
      {limits && (
        <span><b>limits</b> Δyaw ±{fmt(limits.yaw)}° · Δpitch ±{fmt(limits.pitch)}°</span>
      )}
    </div>
  );
}

function TimestampSeek({ duration, onSeek }: { duration: number; onSeek: (time: number) => void }) {
  const submitTimestamp = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const timestamp = Number(new FormData(form).get('timestamp'));
    if (!Number.isFinite(timestamp) || timestamp < 0) return;
    onSeek(Math.min(timestamp, duration));
    form.reset();
  };

  return (
    <form className="timestamp-seek" onSubmit={submitTimestamp}>
      <label>
        Time (s)
        <input name="timestamp" type="number" min="0" step="any" inputMode="decimal" required aria-label="Timestamp in seconds" />
      </label>
      <button type="submit" className="btn small secondary">Go</button>
    </form>
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
  const [videoSource, setVideoSource] = useState<'camera' | 'screen'>('camera');
  const [simPlaying, setSimPlaying] = useState(false);
  const [snapshotLocked, setSnapshotLocked] = useState(false);
  const [dotReviews, setDotReviews] = useState<Record<number, ReviewStatus>>({});
  const [instanceReviews, setInstanceReviews] = useState<Record<string, ReviewStatus>>({});
  const [annotationPopup, setAnnotationPopup] = useState<AnnotationPopup | null>(null);
  const [violationDump, setViolationDump] = useState<UploadedViolationDump | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [calibPreview, setCalibPreview] = useState<CalibPreview | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const videoSwitchTimeRef = useRef(0);
  const scatterWrapRef = useRef<HTMLDivElement>(null);
  const scatterRef = useRef<HTMLCanvasElement>(null);
  const lineRef = useRef<HTMLCanvasElement>(null);
  const plotWrapRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);

  const plotFrames = useMemo(() => buildPlotFrames(session?.gaze ?? null), [session?.gaze]);
  const calibPoints = session?.gaze?.calibration?.points ?? [];
  const modeYaw = session?.gaze?.calibration?.mode?.yaw ?? null;
  const modePitch = session?.gaze?.calibration?.mode?.pitch ?? null;
  const reference = session?.gaze?.calibration?.reference ?? null;
  const limits = session?.gaze?.calibration?.limits ?? null;
  const timelineDuration = videoDuration || plotFrames.at(-1)?.t || 0;
  const hasVideoSourceToggle = Boolean(session?.cameraVideoUrl && session.screenVideoUrl);
  const activeVideoUrl = hasVideoSourceToggle
    ? videoSource === 'camera' ? session?.cameraVideoUrl ?? null : session?.screenVideoUrl ?? null
    : session?.videoUrl ?? null;
  const matchedViolations = useMemo(() => {
    const interviewId = session?.gaze?.interview_id;
    if (!interviewId || !violationDump) return [];
    return violationDump.records.filter((record) => record.interviewId === interviewId);
  }, [session?.gaze?.interview_id, violationDump]);
  const violationInstances = useMemo(
    () => matchedViolations.flatMap((record) => record.instances.map((instance, index) => ({
      key: `${record.id}:${index}`,
      record,
      instance,
      index,
    }))),
    [matchedViolations]
  );
  const dotProgress = reviewProgress(dotReviews);
  const instanceProgress = reviewProgress(
    Object.fromEntries(violationInstances.map(({ key }) => [key, instanceReviews[key]]))
  );

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
      reference,
      limits,
      snapshot: snapshotLocked,
      currentTime,
      width: w,
      height: h,
      title: 'Yaw / pitch',
    };
  }, [plotFrames, calibPoints, modeYaw, modePitch, reference, limits, snapshotLocked, currentTime]);

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
    if (!simPlaying || activeVideoUrl) return;
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
  }, [simPlaying, activeVideoUrl, playbackRate, timelineDuration]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.playbackRate = playbackRate;
  }, [playbackRate, activeVideoUrl]);

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
    if (v && activeVideoUrl) {
      v.pause();
      v.currentTime = t;
    }
    setCurrentTime(t);
  };

  const selectVideoSource = (source: 'camera' | 'screen') => {
    if (source === videoSource) return;
    videoSwitchTimeRef.current = videoRef.current?.currentTime ?? currentTime;
    videoRef.current?.pause();
    setVideoDuration(0);
    setVideoSource(source);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setLoadError(null);
    try {
      new Set([session?.videoUrl, session?.cameraVideoUrl, session?.screenVideoUrl]
        .filter((url): url is string => Boolean(url)))
        .forEach((url) => URL.revokeObjectURL(url));
      session?.calibrationImages.forEach((u) => URL.revokeObjectURL(u));
      setSession(await loadFromFileList(files));
      setCurrentTime(0);
      setVideoDuration(0);
      videoSwitchTimeRef.current = 0;
      setVideoSource('camera');
      setCalibPreview(null);
      setDotReviews({});
      setAnnotationPopup(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  const onViolationFile = async (file: File | null) => {
    if (!file) return;
    setLoadError(null);
    try {
      const data: unknown = JSON.parse(await file.text());
      const records = parseViolationDump(data);
      setViolationDump({
        fileName: file.name,
        records,
      });
      setInstanceReviews({});
    } catch (e) {
      setViolationDump(null);
      setLoadError(e instanceof Error ? e.message : 'Failed to load violation dump');
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
    if (hit?.kind === 'frame') {
      seekToTime(hit.frame.t);
      setAnnotationPopup({
        frame: hit.frame,
        x: Math.max(12, Math.min(e.clientX + 10, window.innerWidth - 270)),
        y: Math.max(12, Math.min(e.clientY + 10, window.innerHeight - 170)),
      });
    } else {
      setAnnotationPopup(null);
    }
  };

  const markDot = (frame: PlotFrame, status: ReviewStatus) => {
    setDotReviews((current) => ({ ...current, [frame.index]: status }));
  };

  const markViolationInstance = (key: string, status: ReviewStatus) => {
    setInstanceReviews((current) => ({ ...current, [key]: status }));
  };

  const exportReviews = () => {
    downloadCsv(
      `${session?.label ?? 'interview'}-annotations.csv`,
      [
        'record_type', 'interview_id', 'violation_id', 'violation_type', 'severity', 'instance_number',
        'timestamp_seconds', 'end_seconds', 'duration_seconds', 'yaw', 'pitch', 'confidence',
        'frame_name', 'frame_timestamp_seconds', 'dyaw', 'dpitch', 'axis', 'prediction', 'annotation',
      ],
      [
        ...plotFrames.map((frame) => [
          'gaze_dot', session?.gaze?.interview_id ?? '', '', '', '', '', frame.t, '', '',
          frame.yaw, frame.pitch, '', '', '', '', '', frame.pred ?? '', dotReviews[frame.index] ?? '',
        ]),
        ...violationInstances.map(({ key, record, instance, index }) => [
          'violation_instance', record.interviewId, record.id, record.type, record.severity, index + 1,
          instance.startSeconds, instance.endSeconds, instance.durationSeconds, '', '', instance.confidence,
          instance.frameName, instance.frameTimeSeconds, instance.dyaw, instance.dpitch, instance.axis, '',
          instanceReviews[key] ?? '',
        ]),
      ]
    );
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
          {session?.videoUrl && (
            <label className="btn secondary" title={violationDump?.fileName ?? 'Open a proctoring violations JSON dump'}>
              {violationDump ? `Violations (${violationInstances.length})` : 'Open violations'}
              <input type="file" hidden accept=".json,application/json" onChange={(e) => onViolationFile(e.target.files?.[0] ?? null)} />
            </label>
          )}
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
                {activeVideoUrl ? (
                  <>
                    <div className="video-wrap">
                      <video
                        key={activeVideoUrl}
                        ref={videoRef}
                        src={activeVideoUrl}
                        controls
                        onTimeUpdate={onTimeUpdate}
                        onSeeked={onTimeUpdate}
                        onLoadedMetadata={() => {
                          const v = videoRef.current;
                          if (v) {
                            const seekTime = Math.min(videoSwitchTimeRef.current, v.duration);
                            v.currentTime = seekTime;
                            setVideoDuration(v.duration);
                            setCurrentTime(seekTime);
                            videoSwitchTimeRef.current = seekTime;
                          }
                        }}
                      />
                    </div>
                    <div className="video-controls">
                      {hasVideoSourceToggle && (
                        <div className="video-source-toggle" role="group" aria-label="Video source">
                          <button
                            type="button"
                            aria-pressed={videoSource === 'camera'}
                            onClick={() => selectVideoSource('camera')}
                          >
                            Camera
                          </button>
                          <button
                            type="button"
                            aria-pressed={videoSource === 'screen'}
                            onClick={() => selectVideoSource('screen')}
                          >
                            Screen
                          </button>
                        </div>
                      )}
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
                      <TimestampSeek duration={timelineDuration} onSeek={seekToTime} />
                    </div>
                    <FrameStats frame={liveFrame} limits={limits} />
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
                      <TimestampSeek duration={timelineDuration} onSeek={seekToTime} />
                    </div>
                    <FrameStats frame={liveFrame} limits={limits} />
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
                <div className="review-summary" aria-live="polite">
                  <span>Dots {dotProgress.percentage == null ? '—' : `${dotProgress.percentage}%`}</span>
                  <span>({dotProgress.correct}/{dotProgress.decided})</span>
                  {violationDump && (
                    <>
                      <span className="review-divider" />
                      <span>Instances {instanceProgress.percentage == null ? '—' : `${instanceProgress.percentage}%`}</span>
                      <span>({instanceProgress.correct}/{instanceProgress.decided})</span>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="btn small secondary"
                  onClick={exportReviews}
                  disabled={!plotFrames.length && !violationInstances.length}
                  title="Download all annotations as CSV"
                >
                  CSV
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={snapshotLocked ? 'Unlock live plot' : 'Lock full plot snapshot'}
                  aria-pressed={snapshotLocked}
                  title={snapshotLocked ? 'Unlock live plot' : 'Lock full plot snapshot'}
                  onClick={() => setSnapshotLocked((locked) => !locked)}
                >
                  <span className={`lock-icon${snapshotLocked ? ' is-locked' : ''}`} aria-hidden="true" />
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
                {limits && <span><i className="limit-box" /> limits</span>}
                {calibPoints.map((c, i) => (
                  <span key={c.name}>
                    <i className="dot" style={{ background: calibColor(c.name, i) }} /> {calibLabel(c.name)}
                  </span>
                ))}
              </div>
            </section>
          </div>

          {violationDump && session.videoUrl && (
            <section className="violation-panel">
              <div className="violation-heading">
                <h2>Proctoring violations</h2>
                <span>{violationInstances.length}</span>
              </div>
              {violationInstances.length ? (
                <div className="violation-list">
                  {violationInstances.map(({ key, record, instance }) => (
                    <div className="violation-row" key={key}>
                      <button
                        type="button"
                        className="violation-seek"
                        onClick={() => instance.startSeconds != null && seekToTime(instance.startSeconds)}
                        disabled={instance.startSeconds == null}
                        title={instance.frameName ?? undefined}
                      >
                        <strong>{record.type || 'Violation'}</strong>
                        <span>
                          {instance.startSeconds == null
                            ? '—'
                            : `${formatTime(instance.startSeconds)} - ${formatTime(instance.endSeconds ?? instance.startSeconds)}`}
                        </span>
                        <span>{record.severity}</span>
                      </button>
                      <div className="instance-annotations" role="group" aria-label="Annotate violation instance">
                        {(['correct', 'incorrect', 'unsure'] as const).map((status) => (
                          <button
                            key={status}
                            type="button"
                            className={`annotation-choice status-${status}${instanceReviews[key] === status ? ' is-selected' : ''}`}
                            aria-pressed={instanceReviews[key] === status}
                            onClick={() => markViolationInstance(key, status)}
                          >
                            {status[0].toUpperCase() + status.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="gallery-empty">
                  {session.gaze?.interview_id ? 'No instances for this interview.' : 'Interview ID is unavailable.'}
                </p>
              )}
            </section>
          )}

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

      {annotationPopup && (
        <div
          className="annotation-popup"
          style={{ left: annotationPopup.x, top: annotationPopup.y }}
          role="dialog"
          aria-label="Annotate gaze point"
        >
          <div className="annotation-point">
            {formatTime(annotationPopup.frame.t)} · y={fmt(annotationPopup.frame.yaw)} · p={fmt(annotationPopup.frame.pitch)}
          </div>
          <div className="annotation-actions">
            {(['correct', 'incorrect', 'unsure'] as const).map((status) => (
              <button
                key={status}
                type="button"
                className={`annotation-choice status-${status}${dotReviews[annotationPopup.frame.index] === status ? ' is-selected' : ''}`}
                aria-pressed={dotReviews[annotationPopup.frame.index] === status}
                onClick={() => markDot(annotationPopup.frame, status)}
              >
                {status[0].toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
          <div className="annotation-footer">
            <button type="button" className="annotation-close" onClick={() => setAnnotationPopup(null)} aria-label="Close annotation">
              ×
            </button>
          </div>
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
