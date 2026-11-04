const PANEL_ID = 'securetestProctorPanel';
let stream = null, video = null, faceDetector = null, objectModel = null;
let active = false, loopTimer = null, snapshotConsent = false, testId = null;
let multiSince = 0, missingSince = 0, phoneHits = 0, lastSent = new Map(), warningCount = 0;

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
  if (el) el.textContent = count >= 3 ? 'Termination threshold reached (3/3)' : 'Warnings: ' + count + ' / 2';
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const old = Array.from(document.scripts).find(item => item.src === src);
    if (old) {
      if (old.dataset.loaded === 'yes') return resolve();
      old.addEventListener('load', resolve, { once: true });
      old.addEventListener('error', reject, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => { script.dataset.loaded = 'yes'; resolve(); };
    script.onerror = () => reject(new Error('AI library download failed'));
    document.head.appendChild(script);
  });
}
async function loadModels() {
  setStatus('Loading local face and phone detection models…');
  const visionModule = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14');
  const vision = await visionModule.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
  );
  faceDetector = await visionModule.FaceDetector.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
      delegate: 'CPU'
    },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.65
  });
  await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js');
  await loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js');
  objectModel = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
}
function captureSnapshot() {
  if (!snapshotConsent || !video || !video.videoWidth) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = Math.max(1, Math.round(640 * video.videoHeight / video.videoWidth));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.58);
}
async function reportViolation(eventType, detector = 'browser', confidence = null) {
  if (!active || !testId) return null;
  const now = Date.now();
  if (now - (lastSent.get(eventType) || 0) < 18000) return null;
  lastSent.set(eventType, now);
  const payload = { eventType, detector, confidence };
  const snapshot = captureSnapshot();
  if (snapshot) payload.snapshot = snapshot;
  try {
    const response = await fetch('/api/proctoring/events', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not record event');
    if (result.accepted) {
      setWarnings(result.violationCount);
      setStatus(result.terminated ? 'Examination ended after the third confirmed violation.' :
        'Proctoring active. Please remain visible and alone.');
      if (!result.terminated && typeof window.toast === 'function') {
        const reasons = {
          multiple_faces: 'More than one face was detected in the camera view.',
          face_missing: 'Your face has not been visible for several seconds.',
          phone_detected: 'A possible mobile phone was detected.',
          tab_hidden: 'You switched away from the examination tab.',
          window_blur: 'The examination window lost focus.',
          fullscreen_exit: 'You exited full-screen mode.',
          copy_attempt: 'A restricted copy or keyboard action was detected.'
        };
        window.toast('Warning ' + result.violationCount + ' of 2: ' + (reasons[eventType] || 'Suspicious activity detected.'));
      }
    }
    if (result.terminated && typeof window.secureTestAutoTerminate === 'function') {
      active = false;
      stop();
      window.secureTestAutoTerminate();
    }
    return result;
  } catch (error) {
    // The RPC may have committed even if the HTTP response was lost. Re-read
    // the server session so the browser cannot miss warning 3 / termination.
    try {
      const check = await fetch('/api/proctoring/session', { credentials: 'include' });
      if (check.ok) {
        const session = await check.json();
        setWarnings(Number(session.violationCount) || 0);
        if (session.status === 'terminated') {
          setStatus('Examination ended after the third confirmed violation.');
          active = false;
          stop();
          if (typeof window.secureTestAutoTerminate === 'function') window.secureTestAutoTerminate();
          return { accepted: true, violationCount: Number(session.violationCount) || 3, terminated: true, status: 'terminated' };
        }
      }
    } catch (syncError) {
      console.error('Could not synchronize proctoring session:', syncError);
    }
    setStatus('Proctoring connection problem. Contact the invigilator.');
    console.error('Proctoring event failed:', error);
    return null;
  }
}
async function detectLoop() {
  if (!active || !video || video.readyState < 2) {
    if (active) loopTimer = window.setTimeout(detectLoop, 1500);
    return;
  }
  const now = Date.now();
  try {
    const faceResult = faceDetector.detectForVideo(video, performance.now());
    const faces = faceResult.detections || [];
    if (faces.length >= 2) {
      if (!multiSince) multiSince = now;
      if (now - multiSince >= 2200) {
        await reportViolation('multiple_faces', 'mediapipe-face-detector', 0.75);
        multiSince = now;
      }
    } else multiSince = 0;

    if (faces.length === 0) {
      if (!missingSince) missingSince = now;
      if (now - missingSince >= 9000) {
        await reportViolation('face_missing', 'mediapipe-face-detector', 0.7);
        missingSince = now;
      }
    } else missingSince = 0;

    const objects = await objectModel.detect(video);
    const phones = objects.filter(item => item.class === 'cell phone' && item.score >= 0.68);
    if (phones.length) {
      phoneHits += 1;
      if (phoneHits >= 2) {
        await reportViolation('phone_detected', 'coco-ssd', phones[0].score);
        phoneHits = 0;
      }
    } else phoneHits = 0;
  } catch (error) {
    console.error('Local proctoring inference error:', error);
    setStatus('AI detection paused. Contact the invigilator.');
  }
  if (active) loopTimer = window.setTimeout(detectLoop, 1800);
}
async function prepare() {
  const panel = ensurePanel();
  if (!panel.querySelector('#stpCameraConsent')?.checked) {
    throw new Error('Please agree to camera monitoring before starting the examination.');
  }
  setStatus('Requesting camera permission…');
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires HTTPS and a supported browser.');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    });
  } catch {
    throw new Error('Camera permission is required. Allow camera access and try again.');
  }
  video = panel.querySelector('#stpVideo');
  video.srcObject = stream;
  await video.play();
  try {
    await loadModels();
  } catch (error) {
    stop();
    throw new Error('AI proctoring could not initialize. Check the internet connection and try again.');
  }
  snapshotConsent = !!panel.querySelector('#stpSnapshotConsent')?.checked;
  setStatus(snapshotConsent ? 'Camera ready. Incident snapshots enabled by consent.' :
    'Camera ready. No incident images will be stored.');
  panel.classList.add('stp-live');
  return snapshotConsent;
}
function activate(id, initialWarnings = 0) {
  testId = id;
  active = true;
  multiSince = 0;
  missingSince = 0;
  phoneHits = 0;
  lastSent.clear();
  setWarnings(initialWarnings);
  setStatus('Proctoring active. Keep your face visible and do not use a phone.');
  const panel = ensurePanel();
  const header = document.querySelector('#exam .exam-header');
  if (header && panel.parentElement !== header) header.appendChild(panel);
  detectLoop();
}
function stop() {
  active = false;
  clearTimeout(loopTimer);
  if (stream) stream.getTracks().forEach(track => track.stop());
  stream = null;
  if (video) video.srcObject = null;
  faceDetector = null;
  objectModel = null;
  testId = null;
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.classList.remove('stp-live');
}
ensurePanel();
window.SecureTestProctoring = {
  prepare, activate, stop, reportViolation,
  get warningCount() { return warningCount; }
};
