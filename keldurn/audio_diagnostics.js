(() => {
  'use strict';

  const MAX_RECENT_EVENTS = 128;
  const MAX_UNIQUE_SYNC_XHR = 4096;
  const FRAME_RING_CAPACITY = 512;
  const INCIDENT_FRAME_CAPACITY = 480;
  const MAX_HITCH_INCIDENTS = 16;
  const HITCH_HISTORY_MS = 4000;
  const HITCH_FOLLOWUP_MS = 2000;
  const MIN_HITCH_MS = 25;
  const HITCH_CADENCE_FACTOR = 1.75;
  const REPORT_VERSION = 3;
  const LEGACY_REPORT_VERSION = 1;
  const PHASE_FIELDS = [
    'uiScriptMs', 'uiLayoutMs', 'worldMs', 'extractMs', 'uploadMs', 'prepareMs', 'submitMs',
    'outsideMs',
  ];
  const PHASE_CAUSES = new Set([
    'ui-script', 'ui-layout', 'world-update', 'render-extract', 'asset-upload', 'render-prepare',
    'render-submit', 'outside',
  ]);
  const MAX_PENDING_REPORTS = 32;
  const MAX_PENDING_MINUTES = 15;
  const ACTIVITY_BATCH_SIZE = 5;
  const REPORT_BATCH_SIZE = 16;
  const REPORT_FLUSH_MS = 5000;
  const contexts = [];
  const recent = [];
  const syncXhrSeen = new Set();
  const frameRing = new Float32Array(FRAME_RING_CAPACITY);
  const incidents = [];
  const pendingReports = [];
  const warmedContexts = new Set();
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const startedAt = performance.now();
  let frameRingWrite = 0;
  let frameRingCount = 0;
  let expectedFrameMs = 0;
  let cadenceCandidateMs = 0;
  let cadenceCandidateFrames = 0;
  let lastFrame = startedAt;
  let playable = false;
  let discardNextPlayableFrame = false;
  let activeIncident = null;
  let reportTimer = null;
  let reportInFlight = false;
  let reportsEnabled = true;
  let reportVersion = REPORT_VERSION;
  const pendingMinutes = [];
  let activityInFlight = false;
  let activityEnabled = true;
  let minuteSyncXhrCalls = 0;
  let minuteSyncXhrMs = 0;
  const gpuContext = {
    vendor: null,
    architecture: null,
    fallback: null,
    bc: null,
    etc2: null,
    astc: null,
    timestamps: null,
  };
  let gpuProbed = false;
  let charging = null;
  const metrics = {
    version: 6,
    startedAt,
    audio: {
      contextsCreated: 0,
      workletNodesCreated: 0,
      processorErrors: 0,
      workletCallbacks: 0,
      workletFrames: 0,
      workletNonSilentCallbacks: 0,
      workletSilentFrames: 0,
      workletNonfiniteSamples: 0,
      workletMissedQuanta: 0,
      workletWorstGapUs: 0,
      workletStreamErrors: 0,
      workletFrameSize: 0,
      workletSampleRate: 0,
      offlineContextsCreated: 0,
      browserDecodeAttempts: 0,
      browserDecodeSuccesses: 0,
      browserDecodeFailures: 0,
      browserDecodeFrames: 0,
      browserDecodeTotalMs: 0,
      browserDecodeWorstMs: 0,
      resumeAttempts: 0,
      resumeFailures: 0,
      scheduledBlocks: 0,
      lateBlocks: 0,
      worstLateMs: 0,
      minimumLeadMs: null,
    },
    frames: {
      samples: 0,
      gaps25ms: 0,
      gaps33ms: 0,
      gaps50ms: 0,
      gaps100ms: 0,
      worstGapMs: 0,
      expectedFrameMs: null,
    },
    hitches: { detected: 0, captured: 0, dropped: 0, active: false },
    activity: { minutes: 0, sent: 0, dropped: 0, failures: 0 },
    longTasks: { count: 0, totalMs: 0, worstMs: 0 },
    longAnimationFrames: { count: 0, totalMs: 0, worstMs: 0 },
    syncXhr: { calls: 0, totalMs: 0, worstMs: 0, unique: [] },
    fetch: { calls: 0, failures: 0, inflight: 0, peakInflight: 0, totalMs: 0, worstMs: 0 },
    reporting: { queued: 0, sent: 0, dropped: 0, failures: 0, sampledOut: false },
    lifecycle: { visibilityChanges: 0, hiddenAt: null },
  };

  const pushEvent = (kind, detail = {}) => {
    recent.push({ atMs: performance.now() - startedAt, kind, ...detail });
    if (recent.length > MAX_RECENT_EVENTS) recent.splice(0, recent.length - MAX_RECENT_EVENTS);
  };

  const contextSummary = () => contexts.map((context, index) => ({
    index,
    state: context.state,
    currentTime: context.currentTime,
    sampleRate: context.sampleRate,
    baseLatency: Number.isFinite(context.baseLatency) ? context.baseLatency : null,
    outputLatency: Number.isFinite(context.outputLatency) ? context.outputLatency : null,
  }));

  const memoryBytes = () => {
    const value = Number(performance.memory?.usedJSHeapSize);
    return Number.isFinite(value) ? value : null;
  };

  const counters = () => ({
    longTasks: metrics.longTasks.count,
    syncXhr: metrics.syncXhr.calls,
    fetches: metrics.fetch.calls,
    fetchFailures: metrics.fetch.failures,
    fetchInflight: metrics.fetch.inflight,
    audioMissedQuanta: metrics.audio.workletMissedQuanta,
    audioStreamErrors: metrics.audio.workletStreamErrors,
    audioDecodeFailures: metrics.audio.browserDecodeFailures,
    usedJsHeapBytes: memoryBytes(),
  });

  const frameHistory = () => {
    const history = [];
    let coveredMs = 0;
    for (let offset = 0; offset < frameRingCount && coveredMs < HITCH_HISTORY_MS; offset += 1) {
      const index = (frameRingWrite - 1 - offset + FRAME_RING_CAPACITY) % FRAME_RING_CAPACITY;
      const gapMs = frameRing[index];
      history.push(gapMs);
      coveredMs += gapMs;
    }
    history.reverse();
    return history;
  };

  const severity = (gapMs) => {
    if (gapMs >= 100) return 'freeze';
    if (gapMs >= 50) return 'severe';
    if (gapMs >= 33) return 'visible';
    return 'missed-vsync';
  };

  const finite = (value, fallback = 0, max = 60_000) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(number, max)) : fallback;
  };

  const integer = (value, max = 10_000_000) => Math.round(finite(value, 0, max));

  const dimension = (value, fallback = 'unknown', max = 48) => {
    const clean = String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max);
    return clean || fallback;
  };

  const eventMaximum = (events, kind, field = 'durationMs') => events
    .filter((event) => event.kind === kind)
    .reduce((worst, event) => Math.max(worst, finite(event[field])), 0);

  const loafScriptKind = (script) => {
    const type = dimension(script?.invokerType, 'script', 16);
    let name = String(script?.invoker ?? '');
    if (/^(classic|module)-script$/.test(type) || /^[a-z][a-z0-9+.-]*:/i.test(name)) {
      let url = null;
      try {
        url = typeof URL === 'function' ? new URL(name, window.location?.href) : null;
      } catch (_) {
        url = null;
      }
      name = url && window.location && url.origin === window.location.origin
        ? (url.pathname.split('/').pop() || 'page')
        : 'external';
    }
    return dimension(`${type}:${name}`, 'unknown', 48);
  };

  const loafScripts = (entry) => {
    let scriptMs = 0;
    let worstMs = 0;
    let kind = null;
    for (const script of Array.from(entry?.scripts ?? [])) {
      if (/FrameRequestCallback/i.test(String(script?.invoker ?? ''))) continue;
      const durationMs = finite(script?.duration);
      scriptMs += durationMs;
      if (durationMs > worstMs) {
        worstMs = durationMs;
        kind = loafScriptKind(script);
      }
    }
    return { scriptMs: finite(scriptMs), scriptKind: kind };
  };

  const timeAttribution = (engine, events, report) => {
    const loaf = events
      .filter((event) => event.kind === 'long-animation-frame')
      .reduce((worst, event) => (
        !worst || finite(event.scriptMs) > finite(worst.scriptMs) ? event : worst
      ), null);
    const browserScriptMs = finite(loaf?.scriptMs);
    const fields = {
      causeHint: dimension(engine?.causeHint, 'unknown'),
      browserScriptMs,
      browserScriptKind: browserScriptMs > 0 ? dimension(loaf?.scriptKind, null) : null,
    };
    const phaseCause = PHASE_CAUSES.has(engine?.phaseCause) ? engine.phaseCause : null;
    if (!phaseCause) return { ...fields, phaseCause: null, cause: report.cause };
    for (const field of PHASE_FIELDS) fields[field] = finite(engine[field]);
    const excessMs = finite(engine.phaseExcessMs);
    let cause = phaseCause;
    if (phaseCause === 'outside') {
      if (browserScriptMs > 0 && browserScriptMs >= excessMs * 0.5) cause = 'browser-script';
      else if (report.gpuMs > 0 && report.gpuMs >= report.expectedMs) cause = 'gpu-bound';
      else cause = 'browser-other';
    } else if (phaseCause === 'world-update' && report.syncXhrMs > 0
        && report.syncXhrMs >= excessMs * 0.5) {
      cause = 'sync-xhr';
    }
    return {
      ...fields,
      phaseCause,
      phaseExcessMs: excessMs,
      phaseShare: Math.round(finite(engine.phaseShare, 0, 1) * 100) / 100,
      cause,
    };
  };

  const nearestRefreshRate = (frameMs) => {
    if (!Number.isFinite(frameMs) || frameMs <= 0) return null;
    const measured = 1000 / frameMs;
    return [30, 40, 50, 60, 75, 90, 120, 144, 165, 240]
      .reduce((best, rate) => (
        Math.abs(rate - measured) < Math.abs(best - measured) ? rate : best
      ));
  };

  const deviceProfile = () => {
    const navigator = window.navigator ?? {};
    const userAgent = String(navigator.userAgent ?? '').toLowerCase();
    const touch = Number(navigator.maxTouchPoints ?? 0) > 0;
    let platform = 'other';
    if (/iphone|ipad|ipod/.test(userAgent) || (/macintosh/.test(userAgent) && touch)) {
      platform = 'ios';
    } else if (/android/.test(userAgent)) {
      platform = 'android';
    } else if (/windows/.test(userAgent)) {
      platform = 'windows';
    } else if (/macintosh|mac os/.test(userAgent)) {
      platform = 'macos';
    } else if (/linux/.test(userAgent)) {
      platform = 'linux';
    }
    let browser = 'other';
    if (/edg\//.test(userAgent)) browser = 'edge';
    else if (/firefox\//.test(userAgent)) browser = 'firefox';
    else if (/crios\/|chrome\//.test(userAgent)) browser = 'chrome';
    else if (/safari\//.test(userAgent)) browser = 'safari';
    let deviceClass = 'desktop';
    if (/ipad|tablet/.test(userAgent) || (/android/.test(userAgent) && !/mobile/.test(userAgent))) {
      deviceClass = 'tablet';
    } else if (/iphone|ipod|mobile/.test(userAgent)) {
      deviceClass = 'phone';
    }
    const cores = Number(navigator.hardwareConcurrency);
    const cpuBucket = Number.isFinite(cores)
      ? [1, 2, 4, 8, 16, 32, 64].find((bucket) => cores <= bucket) ?? 64
      : null;
    const memory = Number(navigator.deviceMemory);
    const profile = {
      platform,
      browser,
      deviceClass,
      touch,
      cpuBucket,
      memoryGib: Number.isFinite(memory) ? Math.min(memory, 128) : null,
      refreshHz: nearestRefreshRate(expectedFrameMs),
    };
    if (reportVersion < 2) return profile;
    const dpr = Number(window.devicePixelRatio);
    return {
      ...profile,
      dprQuarter: Number.isFinite(dpr) ? Math.round(Math.min(Math.max(dpr, 0.25), 8) * 4) : null,
      charging,
      gpuVendor: gpuContext.vendor,
      gpuArchitecture: gpuContext.architecture,
      gpuFallback: gpuContext.fallback,
      gpuBc: gpuContext.bc,
      gpuEtc2: gpuContext.etc2,
      gpuAstc: gpuContext.astc,
      gpuTimestamps: gpuContext.timestamps,
    };
  };

  const syncRequestKind = (url) => {
    const path = String(url ?? '').split(/[?#]/, 1)[0];
    const name = path.replace(/^.*?\/data\//i, '').replace(/\\/g, '/');
    const parts = name.split('/').filter(Boolean);
    const ext = (parts.at(-1)?.match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? '').toLowerCase();
    const family = parts.slice(0, Math.min(2, Math.max(parts.length - 1, 1))).join('/');
    return dimension(ext ? `${family}.${ext}` : family, 'unknown');
  };

  const reportForIncident = (incident) => {
    const correlatedEvents = incident.events.filter(
      (event) => event.atMs >= incident.triggerAtMs - 500
        && event.atMs <= incident.triggerAtMs + 500,
    );
    const engine = [...correlatedEvents]
      .reverse()
      .find((event) => event.kind === 'engine-hitch');
    const action = dimension(engine?.action, 'world');
    const mapId = Number.isFinite(Number(engine?.mapId)) ? integer(engine.mapId, 0xffff_ffff) : null;
    const areaId = Number.isFinite(Number(engine?.areaId))
      ? integer(engine.areaId, 0xffff_ffff)
      : null;
    const targetDisplayId = Number.isFinite(Number(engine?.targetDisplayId))
      ? integer(engine.targetDisplayId, 0xffff_ffff)
      : null;
    const targetEntryId = Number.isFinite(Number(engine?.targetEntryId))
      ? integer(engine.targetEntryId, 0xffff_ffff)
      : null;
    const contextKey = `${action}:${mapId ?? '-'}:${areaId ?? '-'}:${targetEntryId ?? '-'}:${targetDisplayId ?? '-'}`;
    const cacheState = warmedContexts.has(contextKey) ? 'warm' : 'cold';
    warmedContexts.add(contextKey);

    const syncXhrMs = eventMaximum(correlatedEvents, 'sync-xhr');
    const worstSyncXhr = correlatedEvents
      .filter((event) => event.kind === 'sync-xhr')
      .reduce((worst, event) => (
        !worst || finite(event.durationMs) > finite(worst.durationMs) ? event : worst
      ), null);
    const longTaskMs = eventMaximum(correlatedEvents, 'long-task');
    const longAnimationFrameMs = eventMaximum(
      correlatedEvents,
      'long-animation-frame',
      'blockingDurationMs',
    );
    const fetchMs = eventMaximum(correlatedEvents, 'fetch-complete');
    const missedBefore = integer(incident.countersBefore?.audioMissedQuanta);
    const missedAfter = integer(incident.countersAfter?.audioMissedQuanta);
    const audioMissedQuanta = Math.max(0, missedAfter - missedBefore);
    const causeHint = dimension(engine?.causeHint, 'unknown');
    let cause = 'unknown';
    if (syncXhrMs > 0) cause = 'sync-xhr';
    else if (causeHint !== 'unknown') cause = causeHint;
    else if (longAnimationFrameMs > 0) cause = 'long-animation-frame';
    else if (longTaskMs > 0) cause = 'main-thread-long-task';
    else if (audioMissedQuanta > 0) cause = 'audio-underrun';
    else if (fetchMs > 0) cause = 'asset-fetch-or-apply';

    const report = {
      release: dimension(engine?.build, 'unknown'),
      profile: dimension(engine?.profile, 'unknown', 24),
      action,
      cause,
      cacheState,
      mapId,
      areaId,
      targetEntryId,
      targetDisplayId,
      frameMs: finite(Math.max(incident.peakGapMs, finite(engine?.wallMs))),
      expectedMs: finite(incident.expectedFrameMs || engine?.expectedMs, 16.67),
      longTaskMs,
      longAnimationFrameMs,
      syncXhrMs,
      fetchMs,
      latencyMs: Number.isFinite(Number(engine?.latencyMs))
        ? integer(engine.latencyMs, 60_000)
        : null,
      entities: integer(engine?.entities, 2_000_000),
      streamedEntities: integer(engine?.streamedEntities, 2_000_000),
      imagesNew: integer(engine?.imagesNew, 100_000),
      meshesNew: integer(engine?.meshesNew, 100_000),
      pipelinesNew: integer(engine?.pipelinesNew, 100_000),
      pipelinesPending: integer(engine?.pipelinesPending, 100_000),
      uiLayoutSolves: integer(engine?.uiLayoutSolves),
      uiLayoutWalks: integer(engine?.uiLayoutWalks),
      uiLayoutDerivations: integer(engine?.uiLayoutDerivations),
      audioMissedQuanta,
    };
    if (reportVersion < 2) return report;
    const v2 = {
      ...report,
      workMs: finite(engine?.workMs, 0, 60_000),
      gpuMs: finite(engine?.gpuMs, 0, 60_000),
      cadenceDivisor: Math.min(4, Math.max(1, integer(engine?.cadenceDivisor, 4) || 1)),
      renderScale: Math.round(finite(engine?.renderScale, 1, 4) * 100) / 100,
      syncXhrKind: worstSyncXhr ? syncRequestKind(worstSyncXhr.url) : null,
    };
    if (reportVersion < 3) return v2;
    return { ...v2, ...timeAttribution(engine, correlatedEvents, v2) };
  };

  const V2_INCIDENT_FIELDS = ['workMs', 'gpuMs', 'cadenceDivisor', 'renderScale', 'syncXhrKind'];
  const V3_INCIDENT_FIELDS = [
    ...PHASE_FIELDS, 'causeHint', 'phaseCause', 'phaseExcessMs', 'phaseShare', 'browserScriptMs',
    'browserScriptKind',
  ];
  const V2_DEVICE_FIELDS = [
    'dprQuarter', 'charging', 'gpuVendor', 'gpuArchitecture', 'gpuFallback', 'gpuBc', 'gpuEtc2',
    'gpuAstc', 'gpuTimestamps',
  ];
  const withoutFields = (value, fields) => {
    const copy = { ...value };
    for (const field of fields) delete copy[field];
    return copy;
  };
  const incidentForVersion = (report, version) => {
    let value = report;
    if (version < 3) value = withoutFields(value, V3_INCIDENT_FIELDS);
    if (version < 2) value = withoutFields(value, V2_INCIDENT_FIELDS);
    return value;
  };

  const scheduleReportFlush = (delay = REPORT_FLUSH_MS) => {
    if (reportTimer !== null || typeof window.setTimeout !== 'function') return;
    reportTimer = window.setTimeout(() => {
      reportTimer = null;
      void flushReports();
    }, delay);
  };

  const flushReports = async () => {
    if (!reportsEnabled || !nativeFetch || reportInFlight || pendingReports.length === 0) return false;
    if (reportTimer !== null && typeof window.clearTimeout === 'function') {
      window.clearTimeout(reportTimer);
      reportTimer = null;
    }
    const batch = pendingReports.splice(0, REPORT_BATCH_SIZE);
    reportInFlight = true;
    try {
      const version = reportVersion;
      const response = await nativeFetch('/api/performance/incidents', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: {
          'content-type': 'application/json',
          'x-requested-with': 'keldurn',
        },
        body: JSON.stringify({
          version,
          device: version < 2 ? withoutFields(deviceProfile(), V2_DEVICE_FIELDS) : deviceProfile(),
          incidents: batch.map((report) => incidentForVersion(report, version)),
        }),
      });
      if (response.status === 400 && version > LEGACY_REPORT_VERSION) {
        reportVersion = version - 1;
        throw new Error('telemetry version downgraded');
      }
      if (!response.ok || response.redirected === true) throw new Error(`telemetry ${response.status}`);
      if (response.headers?.get?.('x-keldurn-telemetry') === 'sampled-out') {
        reportsEnabled = false;
        metrics.reporting.sampledOut = true;
        pendingReports.length = 0;
        return true;
      }
      metrics.reporting.sent += batch.length;
      return true;
    } catch (_) {
      metrics.reporting.failures += 1;
      pendingReports.unshift(...batch);
      if (pendingReports.length > MAX_PENDING_REPORTS) {
        metrics.reporting.dropped += pendingReports.length - MAX_PENDING_REPORTS;
        pendingReports.length = MAX_PENDING_REPORTS;
      }
      scheduleReportFlush(15_000);
      return false;
    } finally {
      reportInFlight = false;
      if (pendingReports.length > 0) scheduleReportFlush();
    }
  };

  const queueIncidentReport = (incident) => {
    if (!reportsEnabled) return;
    if (pendingReports.length >= MAX_PENDING_REPORTS) {
      metrics.reporting.dropped += 1;
      return;
    }
    pendingReports.push(reportForIncident(incident));
    metrics.reporting.queued += 1;
    if (pendingReports.length >= REPORT_BATCH_SIZE) void flushReports();
    else scheduleReportFlush();
  };

  const startIncident = (now, gapMs, source = 'raf') => {
    if (!playable || document.visibilityState !== 'visible') return;
    if (activeIncident) {
      activeIncident.peakGapMs = Math.max(activeIncident.peakGapMs, gapMs);
      if (activeIncident.triggers.length < 64) {
        activeIncident.triggers.push({
          atMs: now - startedAt,
          gapMs,
          source,
          severity: severity(gapMs),
        });
      }
      return;
    }
    const preFrameGapsMs = frameHistory();
    activeIncident = {
      id: metrics.hitches.detected + 1,
      triggerAtMs: now - startedAt,
      captureUntilMs: now + HITCH_FOLLOWUP_MS,
      windowStartMs: now - startedAt - preFrameGapsMs.reduce((sum, value) => sum + value, 0),
      expectedFrameMs,
      peakGapMs: gapMs,
      severity: severity(gapMs),
      triggers: [{ atMs: now - startedAt, gapMs, source, severity: severity(gapMs) }],
      preFrameGapsMs,
      postFrameGapsMs: new Float32Array(INCIDENT_FRAME_CAPACITY),
      postFrameCount: 0,
      countersBefore: counters(),
    };
    metrics.hitches.detected += 1;
    metrics.hitches.active = true;
  };

  const finishIncident = (now) => {
    if (!activeIncident || now < activeIncident.captureUntilMs) return;
    const incident = activeIncident;
    incident.windowEndMs = now - startedAt;
    incident.postFrameGapsMs = Array.from(
      incident.postFrameGapsMs.subarray(0, incident.postFrameCount),
    );
    incident.countersAfter = counters();
    incident.events = recent.filter(
      (event) => event.atMs >= incident.windowStartMs && event.atMs <= incident.windowEndMs,
    );
    if (incidents.length >= MAX_HITCH_INCIDENTS) {
      incidents.shift();
      metrics.hitches.dropped += 1;
    }
    incidents.push(incident);
    queueIncidentReport(incident);
    activeIncident = null;
    metrics.hitches.captured += 1;
    metrics.hitches.active = false;
  };

  const queueMinute = (detail) => {
    metrics.activity.minutes += 1;
    const optionalMs = (value) => (Number.isFinite(Number(value)) ? finite(value) : null);
    const minute = {
      release: dimension(detail.build, 'unknown'),
      profile: dimension(detail.profile, 'unknown', 24),
      activeMs: finite(detail.activeMs, 0, 600_000),
      frames: integer(detail.frames, 1_000_000),
      gaps25: integer(detail.gaps25, 1_000_000),
      gaps50: integer(detail.gaps50, 1_000_000),
      gaps100: integer(detail.gaps100, 1_000_000),
      missed: integer(detail.missed, 1_000_000),
      workP50: optionalMs(detail.workP50),
      workP95: optionalMs(detail.workP95),
      gpuP50: optionalMs(detail.gpuP50),
      gpuP95: optionalMs(detail.gpuP95),
      cadenceDivisor: Math.min(4, Math.max(1, integer(detail.cadenceDivisor, 4) || 1)),
      renderScale: Math.round(finite(detail.renderScale, 1, 4) * 100) / 100,
      displayPeriodMs: optionalMs(detail.displayPeriodMs),
      syncXhrCalls: integer(minuteSyncXhrCalls, 1_000_000),
      syncXhrMs: finite(minuteSyncXhrMs, 0, 600_000),
    };
    minuteSyncXhrCalls = 0;
    minuteSyncXhrMs = 0;
    try {
      const device = deviceProfile();
      window.dispatchEvent?.(new window.CustomEvent('keldurn:frame-minute', {
        detail: {
          ...minute,
          charging,
          gpuVendor: gpuContext.vendor,
          platform: device.platform,
          deviceClass: device.deviceClass,
        },
      }));
    } catch (_) {
    }
    if (!activityEnabled) return;
    if (pendingMinutes.length >= MAX_PENDING_MINUTES) {
      pendingMinutes.shift();
      metrics.activity.dropped += 1;
    }
    pendingMinutes.push(minute);
    if (pendingMinutes.length >= ACTIVITY_BATCH_SIZE) void flushActivity();
  };

  const flushActivity = async () => {
    if (!nativeFetch || !activityEnabled || activityInFlight || pendingMinutes.length === 0) {
      return false;
    }
    const batch = pendingMinutes.splice(0, ACTIVITY_BATCH_SIZE);
    activityInFlight = true;
    try {
      const response = await nativeFetch('/api/performance/activity', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'content-type': 'application/json', 'x-requested-with': 'keldurn' },
        body: JSON.stringify({ version: 1, device: deviceProfile(), minutes: batch }),
      });
      if (response.status === 404 || response.status === 405) {
        activityEnabled = false;
        return false;
      }
      if (!response.ok || response.redirected === true) throw new Error(`activity ${response.status}`);
      metrics.activity.sent += batch.length;
      return true;
    } catch (_) {
      metrics.activity.failures += 1;
      pendingMinutes.unshift(...batch);
      if (pendingMinutes.length > MAX_PENDING_MINUTES) {
        metrics.activity.dropped += pendingMinutes.length - MAX_PENDING_MINUTES;
        pendingMinutes.length = MAX_PENDING_MINUTES;
      }
      return false;
    } finally {
      activityInFlight = false;
    }
  };

  const probeGpu = async () => {
    if (gpuProbed) return;
    gpuProbed = true;
    try {
      const gpu = window.navigator?.gpu;
      if (!gpu?.requestAdapter) return;
      const adapter = await gpu.requestAdapter();
      if (!adapter) return;
      const info = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
      gpuContext.vendor = info.vendor ? dimension(info.vendor, null, 32) : null;
      gpuContext.architecture = info.architecture ? dimension(info.architecture, null, 32) : null;
      if (typeof info.isFallbackAdapter === 'boolean') gpuContext.fallback = info.isFallbackAdapter;
      else if (typeof adapter.isFallbackAdapter === 'boolean') {
        gpuContext.fallback = adapter.isFallbackAdapter;
      }
      const features = adapter.features;
      if (features?.has) {
        gpuContext.bc = features.has('texture-compression-bc');
        gpuContext.etc2 = features.has('texture-compression-etc2');
        gpuContext.astc = features.has('texture-compression-astc');
        gpuContext.timestamps = features.has('timestamp-query');
      }
    } catch (_) {
    }
  };

  const watchBattery = () => {
    try {
      const request = window.navigator?.getBattery?.();
      if (!request?.then) return;
      request.then((battery) => {
        const read = () => {
          charging = typeof battery.charging === 'boolean' ? battery.charging : null;
        };
        read();
        battery.addEventListener?.('chargingchange', read);
      }, () => {});
    } catch (_) {
    }
  };
  watchBattery();

  const mark = (kind, detail = {}) => {
    const now = performance.now();
    if (kind === 'engine-minute') {
      queueMinute(detail);
      return;
    }
    pushEvent(kind, detail);
    if (kind === 'engine-hitch') {
      const gapMs = Number(detail.wallMs);
      if (Number.isFinite(gapMs)) startIncident(now, gapMs, 'engine');
    }
  };

  const safeRequestPath = (input) => {
    const raw = String(input?.url ?? input ?? '');
    return raw.split(/[?#]/, 1)[0].slice(0, 160);
  };

  const setPlayable = (value) => {
    const next = value === true;
    if (playable === next) return;
    const now = performance.now();
    if (!next && activeIncident) {
      activeIncident.captureUntilMs = now;
      finishIncident(now);
    }
    playable = next;
    expectedFrameMs = 0;
    cadenceCandidateMs = 0;
    cadenceCandidateFrames = 0;
    frameRingWrite = 0;
    frameRingCount = 0;
    lastFrame = now;
    discardNextPlayableFrame = next;
    pushEvent('engine-playable', { value: playable });
    if (playable) void probeGpu();
  };

  const incidentSummary = (incident) => ({
    ...incident,
    postFrameGapsMs: Array.from(
      incident.postFrameGapsMs.subarray?.(0, incident.postFrameCount)
        ?? incident.postFrameGapsMs,
    ),
  });

  const snapshot = () => ({
    ...metrics,
    capturedAtMs: performance.now() - startedAt,
    crossOriginIsolated: window.crossOriginIsolated === true,
    visible: document.visibilityState,
    contexts: contextSummary(),
    recent: recent.slice(),
    hitchRecorder: {
      playable,
      expectedFrameMs: expectedFrameMs || null,
      incidents: incidents.map(incidentSummary),
      activeIncident: activeIncident ? incidentSummary(activeIncident) : null,
      pendingReports: pendingReports.length,
    },
  });

  Object.defineProperty(window, '__keldurn_audio_diagnostics', {
    configurable: false,
    enumerable: false,
    value: { metrics, snapshot },
  });

  Object.defineProperty(window, '__keldurn_hitch_recorder', {
    configurable: false,
    enumerable: false,
    value: { mark, setPlayable, snapshot, flushReports, flushActivity },
  });

  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const Original = window[name];
    if (!Original) continue;
    const Patched = function (...args) {
      const context = new Original(...args);
      contexts.push(context);
      metrics.audio.contextsCreated += 1;
      pushEvent('audio-context-created', { state: context.state, sampleRate: context.sampleRate });
      context.addEventListener?.('statechange', () => {
        pushEvent('audio-context-state', { state: context.state });
      });
      return context;
    };
    Patched.prototype = Original.prototype;
    Object.setPrototypeOf(Patched, Original);
    window[name] = Patched;
  }

  const OriginalOfflineContext = window.OfflineAudioContext;
  if (OriginalOfflineContext) {
    const PatchedOfflineContext = function (...args) {
      const context = new OriginalOfflineContext(...args);
      metrics.audio.offlineContextsCreated += 1;
      pushEvent('offline-audio-context-created', { sampleRate: context.sampleRate });
      const originalDecode = context.decodeAudioData.bind(context);
      context.decodeAudioData = (...decodeArgs) => {
        const before = performance.now();
        metrics.audio.browserDecodeAttempts += 1;
        return Promise.resolve(originalDecode(...decodeArgs)).then(
          (buffer) => {
            const durationMs = performance.now() - before;
            metrics.audio.browserDecodeSuccesses += 1;
            metrics.audio.browserDecodeFrames += Number(buffer?.length ?? 0);
            metrics.audio.browserDecodeTotalMs += durationMs;
            metrics.audio.browserDecodeWorstMs = Math.max(
              metrics.audio.browserDecodeWorstMs,
              durationMs,
            );
            pushEvent('browser-audio-decode-complete', {
              durationMs,
              frames: Number(buffer?.length ?? 0),
              channels: Number(buffer?.numberOfChannels ?? 0),
            });
            return buffer;
          },
          (error) => {
            const durationMs = performance.now() - before;
            metrics.audio.browserDecodeFailures += 1;
            metrics.audio.browserDecodeTotalMs += durationMs;
            metrics.audio.browserDecodeWorstMs = Math.max(
              metrics.audio.browserDecodeWorstMs,
              durationMs,
            );
            pushEvent('browser-audio-decode-failed', {
              durationMs,
              message: String(error),
            });
            throw error;
          },
        );
      };
      return context;
    };
    PatchedOfflineContext.prototype = OriginalOfflineContext.prototype;
    Object.setPrototypeOf(PatchedOfflineContext, OriginalOfflineContext);
    window.OfflineAudioContext = PatchedOfflineContext;
  }

  const OriginalWorkletNode = window.AudioWorkletNode;
  if (OriginalWorkletNode) {
    const PatchedWorkletNode = function (...args) {
      const node = new OriginalWorkletNode(...args);
      metrics.audio.workletNodesCreated += 1;
      pushEvent('audio-worklet-node-created');
      node.addEventListener?.('processorerror', (event) => {
        metrics.audio.processorErrors += 1;
        pushEvent('audio-worklet-processor-error', { message: String(event?.message ?? '') });
      });
      return node;
    };
    PatchedWorkletNode.prototype = OriginalWorkletNode.prototype;
    Object.setPrototypeOf(PatchedWorkletNode, OriginalWorkletNode);
    window.AudioWorkletNode = PatchedWorkletNode;
  }

  const resumeContexts = () => {
    for (const context of contexts) {
      if (context.state === 'running' || context.state === 'closed') continue;
      metrics.audio.resumeAttempts += 1;
      Promise.resolve(context.resume()).then(
        () => pushEvent('audio-context-resumed', { state: context.state }),
        (error) => {
          metrics.audio.resumeFailures += 1;
          pushEvent('audio-context-resume-failed', { message: String(error) });
        },
      );
    }
  };
  for (const eventName of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(eventName, resumeContexts, { capture: true, passive: true });
  }

  const sourcePrototype = window.AudioBufferSourceNode?.prototype;
  if (sourcePrototype?.start) {
    const originalStart = sourcePrototype.start;
    sourcePrototype.start = function (when, ...args) {
      const duration = this.buffer?.duration;
      if (Number.isFinite(when) && when > 0 && Number.isFinite(duration)
          && duration >= 0.02 && duration <= 0.1) {
        const leadMs = (when - this.context.currentTime) * 1000;
        metrics.audio.scheduledBlocks += 1;
        metrics.audio.minimumLeadMs = metrics.audio.minimumLeadMs === null
          ? leadMs
          : Math.min(metrics.audio.minimumLeadMs, leadMs);
        if (leadMs < -1) {
          const lateMs = -leadMs;
          metrics.audio.lateBlocks += 1;
          metrics.audio.worstLateMs = Math.max(metrics.audio.worstLateMs, lateMs);
          pushEvent('audio-block-late', { lateMs, durationMs: duration * 1000 });
        }
      }
      return originalStart.call(this, when, ...args);
    };
  }

  const xhrPrototype = window.XMLHttpRequest?.prototype;
  if (xhrPrototype?.open && xhrPrototype?.send) {
    const originalOpen = xhrPrototype.open;
    const originalSend = xhrPrototype.send;
    xhrPrototype.open = function (method, url, async = true, ...args) {
      this.__keldurnSyncXhr = async === false ? { method: String(method), url: String(url) } : null;
      if (this.__keldurnSyncXhr) {
        metrics.syncXhr.calls += 1;
        const key = `${this.__keldurnSyncXhr.method}\n${this.__keldurnSyncXhr.url}`;
        if (!syncXhrSeen.has(key) && syncXhrSeen.size < MAX_UNIQUE_SYNC_XHR) {
          syncXhrSeen.add(key);
          metrics.syncXhr.unique.push({ ...this.__keldurnSyncXhr });
        }
      }
      return originalOpen.call(this, method, url, async, ...args);
    };
    xhrPrototype.send = function (...args) {
      const sync = this.__keldurnSyncXhr;
      if (!sync) return originalSend.apply(this, args);
      const before = performance.now();
      try {
        return originalSend.apply(this, args);
      } finally {
        const durationMs = performance.now() - before;
        minuteSyncXhrCalls += 1;
        minuteSyncXhrMs += durationMs;
        metrics.syncXhr.totalMs += durationMs;
        metrics.syncXhr.worstMs = Math.max(metrics.syncXhr.worstMs, durationMs);
        pushEvent('sync-xhr', { durationMs, method: sync.method, url: sync.url.slice(0, 160) });
      }
    };
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const before = performance.now();
      const path = safeRequestPath(args[0]);
      let bytes = null;
      let status = 0;
      metrics.fetch.calls += 1;
      metrics.fetch.inflight += 1;
      metrics.fetch.peakInflight = Math.max(metrics.fetch.peakInflight, metrics.fetch.inflight);
      try {
        const response = await originalFetch(...args);
        status = Number(response.status ?? 0);
        const contentLength = Number(response.headers?.get?.('content-length'));
        bytes = Number.isFinite(contentLength) && contentLength >= 0 ? contentLength : null;
        if (!response.ok) metrics.fetch.failures += 1;
        return response;
      } catch (error) {
        metrics.fetch.failures += 1;
        throw error;
      } finally {
        const durationMs = performance.now() - before;
        metrics.fetch.inflight -= 1;
        metrics.fetch.totalMs += durationMs;
        metrics.fetch.worstMs = Math.max(metrics.fetch.worstMs, durationMs);
        if (playable) pushEvent('fetch-complete', { durationMs, bytes, status, path });
      }
    };
  }

  if (typeof PerformanceObserver === 'function') {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longTasks.count += 1;
          metrics.longTasks.totalMs += entry.duration;
          metrics.longTasks.worstMs = Math.max(metrics.longTasks.worstMs, entry.duration);
          pushEvent('long-task', { durationMs: entry.duration, startTimeMs: entry.startTime });
        }
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch (_) {
    }
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          metrics.longAnimationFrames.count += 1;
          metrics.longAnimationFrames.totalMs += entry.duration;
          metrics.longAnimationFrames.worstMs = Math.max(
            metrics.longAnimationFrames.worstMs,
            entry.duration,
          );
          pushEvent('long-animation-frame', {
            durationMs: entry.duration,
            startTimeMs: entry.startTime,
            blockingDurationMs: Number(entry.blockingDuration ?? 0),
            scriptCount: Number(entry.scripts?.length ?? 0),
            ...loafScripts(entry),
          });
        }
      });
      observer.observe({ type: 'long-animation-frame', buffered: true });
    } catch (_) {
    }
  }

  const sampleFrame = (now) => {
    const gapMs = now - lastFrame;
    lastFrame = now;
    metrics.frames.samples += 1;
    metrics.frames.worstGapMs = Math.max(metrics.frames.worstGapMs, gapMs);
    if (gapMs >= 25) metrics.frames.gaps25ms += 1;
    if (gapMs >= 33) metrics.frames.gaps33ms += 1;
    if (gapMs >= 50) metrics.frames.gaps50ms += 1;
    if (gapMs >= 100) metrics.frames.gaps100ms += 1;
    if (playable && document.visibilityState === 'visible' && gapMs > 0 && gapMs < 1000) {
      if (discardNextPlayableFrame) {
        discardNextPlayableFrame = false;
        requestAnimationFrame(sampleFrame);
        return;
      }
      frameRing[frameRingWrite] = gapMs;
      frameRingWrite = (frameRingWrite + 1) % FRAME_RING_CAPACITY;
      frameRingCount = Math.min(frameRingCount + 1, FRAME_RING_CAPACITY);

      if (expectedFrameMs === 0) {
        expectedFrameMs = gapMs;
      } else {
        const thresholdMs = Math.max(MIN_HITCH_MS, expectedFrameMs * HITCH_CADENCE_FACTOR);
        const cadenceRatio = gapMs / expectedFrameMs;
        let cadencePromoted = false;
        if (gapMs <= 40 && cadenceRatio >= 1.8 && cadenceRatio <= 2.2) {
          const agrees = cadenceCandidateFrames === 0
            || Math.abs(gapMs - cadenceCandidateMs) <= cadenceCandidateMs * 0.1;
          cadenceCandidateMs = agrees
            ? cadenceCandidateMs + (gapMs - cadenceCandidateMs) / (cadenceCandidateFrames + 1)
            : gapMs;
          cadenceCandidateFrames = agrees ? cadenceCandidateFrames + 1 : 1;
          if (cadenceCandidateFrames >= 8) {
            expectedFrameMs = cadenceCandidateMs;
            cadenceCandidateMs = 0;
            cadenceCandidateFrames = 0;
            cadencePromoted = true;
          }
        } else if (gapMs <= expectedFrameMs * 1.5) {
          cadenceCandidateMs = 0;
          cadenceCandidateFrames = 0;
        }
        if (!cadencePromoted && gapMs >= thresholdMs) startIncident(now, gapMs);
        if (gapMs <= expectedFrameMs * 1.5) {
          expectedFrameMs += (gapMs - expectedFrameMs) * 0.02;
        }
      }
      metrics.frames.expectedFrameMs = expectedFrameMs;
      if (activeIncident && activeIncident.postFrameCount < INCIDENT_FRAME_CAPACITY) {
        activeIncident.postFrameGapsMs[activeIncident.postFrameCount] = gapMs;
        activeIncident.postFrameCount += 1;
      }
      finishIncident(now);
    }
    requestAnimationFrame(sampleFrame);
  };
  requestAnimationFrame(sampleFrame);

  document.addEventListener('visibilitychange', () => {
    metrics.lifecycle.visibilityChanges += 1;
    metrics.lifecycle.hiddenAt = document.visibilityState === 'hidden' ? performance.now() : null;
    pushEvent('visibility', { state: document.visibilityState });
    if (document.visibilityState === 'visible') {
      lastFrame = performance.now();
      discardNextPlayableFrame = playable;
      resumeContexts();
    } else {
      const now = performance.now();
      if (activeIncident) {
        activeIncident.captureUntilMs = now;
        finishIncident(now);
      }
      expectedFrameMs = 0;
      cadenceCandidateMs = 0;
      cadenceCandidateFrames = 0;
      frameRingWrite = 0;
      frameRingCount = 0;
      discardNextPlayableFrame = false;
      void flushReports();
      void flushActivity();
    }
  });

  window.addEventListener('pagehide', () => {
    const now = performance.now();
    if (activeIncident) {
      activeIncident.captureUntilMs = now;
      finishIncident(now);
    }
    void flushReports();
    void flushActivity();
  });
})();
