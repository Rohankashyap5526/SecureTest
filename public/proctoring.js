// Camera + browser proctoring (runs entirely on the candidate's device).
//
// Strikes (counted by the server, 3 = termination): multiple_faces, phone_detected,
// face_missing, camera_lost, tab_hidden, window_blur, fullscreen_exit.
// Review-only flags (logged for the invigilator, never a strike): looking_away,
// copy_attempt, screenshot_key, multi_monitor.
const PANEL_ID = 'securetestProctorPanel';
const MP_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
const TFJS_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

const REVIEW_ONLY = new Set(['looking_away', 'copy_attempt', 'screenshot_key', 'multi_monitor']);
const TUNING = {
  tickMs: 700,                 // face check cadence
  objectEvery: 4,              // phone check every 4th tick (~2.8 s): heavier model
  faceMinScore: 0.55,
  secondFaceMinRatio: 0.2,     // 2nd face must be >= 20% of the main face's area (ignores far-away people/posters)
  multiConsecutive: 3,         // ~2 s of consecutive frames
  faceMissingMs: 7000,
  phoneMinScore: 0.55,
  phoneConsecutive: 2,
  lookAwayYaw: 0.6,            // nose offset / eye distance
  lookAwayMs: 6000,
  cameraLostMs: 5000,
  heartbeatMs: 20000,
  cooldownMs: 18000,           // per strike type
  reviewCooldownMs: 12000
};

let stream = null, video = null, faceDetector = null, objectModel = null, modelsPromise = null;
let active = false, loopTimer = null, hbTimer = null, reacquiring = false, snapshotConsent = false, testId = null;
let multiCount = 0, missingSince = 0, phoneHits = 0, lookAwaySince = 0, cameraBadSince = 0, tickCount = 0, detectorFaults = 0;
let lastSent = new Map(), warningCount = 0, maxViolations = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensurePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;
  panel = document.createElement('section');
  panel.id = PANEL_ID;
  panel.innerHTML =
    '<div class="stp-copy"><strong>Camera proctoring</strong>' +
    '<span id="stpStatus">Camera permission is required before the exam.</span>' +
    '<small id="stpWarnings">Confirmed warnings: 0 / 2</small>' +
    '<label class="stp-consent"><input id="stpCameraConsent" type="checkbox"> I agree to camera monitoring during this examination. Camera processing runs on this device.</label>' +
    '<label class="stp-consent"><input id="stpSnapshotConsent" type="checkbox"> I separately consent to private incident-only snapshots if a violation is detected. Snapshots are not continuous recordings.</label></div>' +
    '<video id="stpVideo" autoplay muted playsinline></video>';
  const style = document.createElement('style');
  style.textContent =
    '#' + PANEL_ID + '{display:flex;align-items:center;gap:14px;padding:14px;margin:16px 0;border:1px solid #dbe3ef;border-radius:14px;background:#f8fafc;color:#172033}' +
    '#' + PANEL_ID + ' .stp-copy{display:flex;flex:1;min-width:0;flex-direction:column;gap:6px;font-size:13px}' +
    '#' + PANEL_ID + ' .stp-copy>span{color:#526176}' +
    '#' + PANEL_ID + ' .stp-copy small{font-weight:700;color:#9a5a00}' +
    '#' + PANEL_ID + ' .stp-consent{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.4;color:#475569}' +
    '#' + PANEL_ID + ' .stp-consent input{margin-top:2px}' +
    '#' + PANEL_ID + ' video{width:160px;height:120px;object-fit:cover;background:#111827;border-radius:10px;transform:scaleX(-1)}' +
    '#' + PANEL_ID + '.stp-live{border-color:#86c9a1;background:#f0fdf4}' +
    '#' + PANEL_ID + '.stp-live video{outline:2px solid #16a34a}' +
    '@media(max-width:640px){#' + PANEL_ID + '{align-items:stretch;flex-direction:column}#' + PANEL_ID + ' video{width:100%;height:180px}}' +
    'body.exam #' + PANEL_ID + '{position:fixed;right:12px;top:82px;z-index:80;width:300px;max-width:calc(100vw - 24px);padding:8px;box-shadow:0 8px 28px #0f172a22}' +
    'body.exam #' + PANEL_ID + ' .stp-consent{display:none}' +
    'body.exam #' + PANEL_ID + ' video{width:92px;height:68px}' +
    'body.exam #' + PANEL_ID + ' .stp-copy{font-size:11px}' +
    'body.exam #' + PANEL_ID + ' .stp-copy small{font-size:10px}';
  document.head.appendChild(style);
  const card = document.querySelector('#instructions .form-card');
  if (card) {
    const actions = card.querySelector('.form-actions');
    card.insertBefore(panel, actions || null);
  }
  video = panel.querySelector('#stpVideo');
  return panel;
}

function setStatus(message) {
  const el = document.getElementById('stpStatus');
  if (el) el.textContent = message;
}
function setWarnings(count) {
  warningCount = count;
  const el = document.getElementById('stpWarnings');
  if (el) el.textContent = count >= maxViolations ? 'Termination threshold reached (' + maxViolations + '/' + maxViolations + ')' : 'Warnings: ' + count + ' / ' + (maxViolations - 1);
}

async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i += 1) {
    try { return await fn(); } catch (error) {
      if (i >= tries - 1) throw error;
      await sleep(700 * (i + 1) + Math.random() * 500); // jitter: 150 laptops must not retry in lockstep
    }
  }
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts).find((item) => item.src === src);
    if (existing && existing.dataset.loaded === 'yes') return resolve();
    if (existing) existing.remove(); // a failed/pending element can never fire again: replace it
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => { script.dataset.loaded = 'yes'; resolve(); };
    script.onerror = () => { script.remove(); reject(new Error('AI library download failed')); };
    document.head.appendChild(script);
  });
}
async function loadModels() {
  setStatus('Loading face and phone detection models…');
  // Explicit .mjs file: a bare package URL may resolve to a CommonJS build.
  const mp = await withRetry(() => import(MP_BASE + '/vision_bundle.mjs'));
  const fileset = await withRetry(() => mp.FilesetResolver.forVisionTasks(MP_BASE + '/wasm'));
  const create = (delegate) => mp.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
    runningMode: 'VIDEO',
    minDetectionConfidence: TUNING.faceMinScore
  });
  try { faceDetector = await create('GPU'); } catch { faceDetector = await withRetry(() => create('CPU')); }
  await withRetry(() => loadScript(TFJS_URL));
  await withRetry(() => loadScript(COCO_URL));
  objectModel = await withRetry(() => window.cocoSsd.load({ base: 'lite_mobilenet_v2' }));
}
// Start downloading while the candidate reads the instructions, so the Start click is fast
// even when 150 candidates press it together.
function preload() {
  if (!modelsPromise) modelsPromise = loadModels().catch((error) => { modelsPromise = null; faceDetector = null; objectModel = null; throw error; });
  return modelsPromise;
}

function trackLive() {
  return !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled && !t.muted);
}
function captureSnapshot() {
  if (!snapshotConsent || !video || !video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = Math.max(1, Math.round(480 * video.videoHeight / video.videoWidth));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}

function handleTermination(reason) {
  if (!active) return;
  active = false;
  stop();
  if (typeof window.secureTestAutoTerminate === 'function') window.secureTestAutoTerminate(reason);
}

async function postJson(url, payload) {
  const response = await fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let data = {};
  try { data = await response.json(); } catch { /* empty */ }
  return { ok: response.ok, status: response.status, data };
}

const REASONS = {
  multiple_faces: 'More than one person was detected in the camera view.',
  face_missing: 'Your face has not been visible for several seconds.',
  phone_detected: 'A possible mobile phone was detected.',
  camera_lost: 'The camera stopped working or was blocked.',
  tab_hidden: 'You switched away from the examination tab.',
  window_blur: 'The examination window lost focus.',
  fullscreen_exit: 'You exited full-screen mode.'
};

async function reportViolation(eventType, detector = 'browser', confidence = null, note = null) {
  if (!active || !testId) return null;
  const reviewOnly = REVIEW_ONLY.has(eventType);
  const now = Date.now();
  if (now - (lastSent.get(eventType) || 0) < (reviewOnly ? TUNING.reviewCooldownMs : TUNING.cooldownMs)) return null;
  lastSent.set(eventType, now);
  const payload = { eventType, detector, confidence };
  if (note) payload.note = note;
  if (!reviewOnly) { const snapshot = captureSnapshot(); if (snapshot) payload.snapshot = snapshot; }

  // A strike must not be lost to a network blip: retry a few times.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { ok, status, data: result } = await postJson('/api/proctoring/events', payload);
      if (status === 403) { await checkSession(); return null; }
      if (!ok) throw new Error(result.error || 'Could not record event');
      if (result.maxViolations) { maxViolations = result.maxViolations; }
      if (result.accepted && result.counted) {
        setWarnings(result.violationCount);
        setStatus(result.terminated ? 'Examination ended after the final confirmed violation.' : 'Proctoring active. Please remain visible and alone.');
        if (!result.terminated && typeof window.toast === 'function') {
          window.toast('Warning ' + result.violationCount + ' of ' + (maxViolations - 1) + ': ' + (REASONS[eventType] || 'Suspicious activity detected.'));
        }
      }
      if (result.terminated) handleTermination('terminated');
      return result;
    } catch (error) {
      if (attempt === 2) console.error('Proctoring event failed:', error);
      else await sleep(900 * (attempt + 1));
    }
  }
  await checkSession(); // the RPC may have committed even though the response was lost
  return null;
}

async function checkSession() {
  try {
    const check = await fetch('/api/proctoring/session', { credentials: 'include' });
    if (!check.ok) return;
    const session = await check.json();
    if (session.maxViolations) maxViolations = session.maxViolations;
    setWarnings(Number(session.violationCount) || 0);
    if (typeof window.secureTestSync === 'function') window.secureTestSync(session);
    if (session.status === 'terminated') handleTermination('terminated');
    else if (session.status === 'expired') handleTermination('expired');
  } catch (error) { console.error('Could not synchronize proctoring session:', error); }
}

// ---- detection ----
function faceArea(d) { const b = d.boundingBox || {}; return Math.max(0, (b.width || 0) * (b.height || 0)); }
function yawRatio(d) {
  const k = d.keypoints || []; // [eye, eye, nose tip, mouth, ear, ear], normalised 0..1
  if (k.length < 3) return 0;
  const eyeDist = Math.abs(k[0].x - k[1].x);
  if (eyeDist < 0.01) return 0;
  return (k[2].x - (k[0].x + k[1].x) / 2) / eyeDist;
}
function analyzeFaces(now) {
  const result = faceDetector.detectForVideo(video, performance.now());
  const faces = (result.detections || []).filter((d) => (d.categories?.[0]?.score || 0) >= TUNING.faceMinScore)
    .sort((a, b) => faceArea(b) - faceArea(a));

  // 1) more than one real person close to the screen
  const second = faces[1];
  if (second && faceArea(second) >= TUNING.secondFaceMinRatio * faceArea(faces[0])) {
    multiCount += 1;
    if (multiCount >= TUNING.multiConsecutive) { multiCount = 0; reportViolation('multiple_faces', 'mediapipe-face', second.categories[0].score); }
  } else multiCount = 0;

  // 2) nobody in front of the camera
  if (faces.length === 0) {
    if (!missingSince) missingSince = now;
    if (now - missingSince >= TUNING.faceMissingMs) { missingSince = now; reportViolation('face_missing', 'mediapipe-face', null); }
  } else missingSince = 0;

  // 3) head turned away for a long time (review-only: glancing at a neighbour / second screen)
  if (faces.length === 1 && Math.abs(yawRatio(faces[0])) > TUNING.lookAwayYaw) {
    if (!lookAwaySince) lookAwaySince = now;
    if (now - lookAwaySince >= TUNING.lookAwayMs) { lookAwaySince = now; reportViolation('looking_away', 'mediapipe-face', null, 'head turned'); }
  } else lookAwaySince = 0;
  return faces.length;
}
async function analyzeObjects() {
  const objects = await objectModel.detect(video, 8, 0.45);
  const phones = objects.filter((item) => item.class === 'cell phone' && item.score >= TUNING.phoneMinScore);
  if (phones.length) {
    phoneHits += 1;
    if (phoneHits >= TUNING.phoneConsecutive) { phoneHits = 0; reportViolation('phone_detected', 'coco-ssd', phones[0].score); }
  } else phoneHits = 0;
}
async function reacquireCamera() {
  if (reacquiring || !active) return;
  reacquiring = true;
  try {
    const fresh = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
    if (!active) { fresh.getTracks().forEach((t) => t.stop()); return; }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = fresh; video.srcObject = fresh; await video.play();
    cameraBadSince = 0;
    setStatus('Camera restored. Proctoring active.');
  } catch { /* still unavailable; keep trying on later ticks */ }
  finally { reacquiring = false; }
}
async function detectLoop() {
  if (!active) return;
  const now = Date.now();
  try {
    if (!video || video.readyState < 2 || !trackLive()) {
      // Unplugged, switched off, blocked by the OS or paused: this used to go completely unnoticed.
      if (!cameraBadSince) cameraBadSince = now;
      if (now - cameraBadSince >= TUNING.cameraLostMs) {
        setStatus('Camera not available. Reconnect or unblock it now.');
        cameraBadSince = now;
        reportViolation('camera_lost', 'browser-camera', null);
      }
      reacquireCamera();
    } else {
      cameraBadSince = 0;
      analyzeFaces(now);
      tickCount += 1;
      if (tickCount % TUNING.objectEvery === 0) await analyzeObjects();
    }
  } catch (error) {
    detectorFaults += 1;
    console.error('Local proctoring inference error:', error);
    if (detectorFaults >= 3) setStatus('AI detection paused. Contact the invigilator.');
  }
  if (active) loopTimer = window.setTimeout(detectLoop, TUNING.tickMs);
}

// Candidate must be visible (one face) before the exam starts: proves camera + detector both work.
async function verifyFaceVisible() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        const result = faceDetector.detectForVideo(video, performance.now());
        const faces = (result.detections || []).filter((d) => (d.categories?.[0]?.score || 0) >= TUNING.faceMinScore);
        if (faces.length === 1) return;
        if (faces.length > 1) setStatus('Only the candidate may be in view. Ask others to move away.');
        else setStatus('Look at the screen so your face is clearly visible, with good lighting.');
      } catch (error) { throw new Error('AI proctoring could not initialize. Refresh the page and try again.'); }
    }
    await sleep(400);
  }
  throw new Error('We could not see exactly one face. Improve the lighting, face the camera, and try again.');
}

async function prepare() {
  const panel = ensurePanel();
  if (!panel.querySelector('#stpCameraConsent')?.checked) {
    throw new Error('Please agree to camera monitoring before starting the examination.');
  }
  setStatus('Requesting camera permission…');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS and a supported browser.');
  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } });
  } catch {
    throw new Error('Camera permission is required. Allow camera access and try again.');
  }
  video = panel.querySelector('#stpVideo');
  video.srcObject = stream;
  await video.play();
  try {
    await preload();
  } catch {
    stopStream();
    throw new Error('AI proctoring could not initialize. Check the internet connection and try again.');
  }
  try { await verifyFaceVisible(); } catch (error) { stopStream(); throw error; }
  snapshotConsent = !!panel.querySelector('#stpSnapshotConsent')?.checked;
  setStatus(snapshotConsent ? 'Camera ready. Incident snapshots enabled by consent.' : 'Camera ready. No incident images will be stored.');
  panel.classList.add('stp-live');
  return snapshotConsent;
}

// ---- heartbeat: lets the server notice a proctor that was switched off, keeps the timer on server time ----
async function sendHeartbeat() {
  if (!active) return;
  const state = {
    camera: trackLive(), models: !!faceDetector && !!objectModel, fullscreen: !!document.fullscreenElement,
    visible: !document.hidden, monitors: window.screen?.isExtended === true, faults: detectorFaults
  };
  try {
    const { ok, data } = await postJson('/api/proctoring/heartbeat', { state });
    if (!ok || !active) return;
    if (data.maxViolations) maxViolations = data.maxViolations;
    setWarnings(Number(data.violationCount) || 0);
    if (typeof window.secureTestSync === 'function') window.secureTestSync(data);
    if (data.status === 'terminated') handleTermination('terminated');
    else if (data.status === 'expired') handleTermination('expired');
  } catch { /* offline: the next beat will catch up */ }
}

function activate(id, initialWarnings = 0, maxAllowed = 3) {
  testId = id;
  active = true;
  maxViolations = maxAllowed || 3;
  multiCount = 0; missingSince = 0; phoneHits = 0; lookAwaySince = 0; cameraBadSince = 0; tickCount = 0; detectorFaults = 0;
  lastSent.clear();
  setWarnings(initialWarnings);
  setStatus('Proctoring active. Keep your face visible and do not use a phone.');
  const panel = ensurePanel();
  const header = document.querySelector('#exam .exam-header');
  if (header && panel.parentElement !== header) header.appendChild(panel);
  if (stream) stream.getVideoTracks().forEach((t) => { t.onended = () => { cameraBadSince = cameraBadSince || (Date.now() - TUNING.cameraLostMs + 1500); }; });
  if (window.screen?.isExtended === true) reportViolation('multi_monitor', 'browser', null, 'extended display');
  clearInterval(hbTimer);
  hbTimer = setInterval(sendHeartbeat, TUNING.heartbeatMs);
  sendHeartbeat();
  detectLoop();
}
function stopStream() {
  if (stream) stream.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  stream = null;
  if (video) video.srcObject = null;
}
function stop() {
  active = false;
  clearTimeout(loopTimer);
  clearInterval(hbTimer);
  stopStream();
  // Models stay loaded: a failed start followed by a retry must not re-download or crash.
  testId = null;
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.classList.remove('stp-live');
}
ensurePanel();
window.SecureTestProctoring = {
  prepare, preload, activate, stop, reportViolation,
  get warningCount() { return warningCount; }
};
