# SecureTest Camera Proctoring – Setup & Operations

This document describes the camera-proctoring work on the `security-hardening` branch. It is not enabled in production until the SQL migration is applied and the branch is deployed deliberately.

## What is included

- Mandatory camera permission and camera-monitoring acknowledgement before an exam starts.
- Local browser-side face counting using MediaPipe Face Detector.
- Local mobile-phone object detection using TensorFlow.js COCO-SSD.
- Detection runs on the candidate's laptop; continuous video is not uploaded.
- Two warnings are shown for the first two accepted incidents. The third accepted incident changes the server-side exam session to `terminated` and asks the browser to submit immediately.
- Server-side event debounce (8 seconds) and browser-side event debounce (18 seconds per event type).
- Automatic answer autosave to the private `exam_sessions.saved_answers` column.
- Optional incident-only JPEG snapshots. Snapshot consent is a separate, unchecked-by-default checkbox. If consent is not granted, no image is sent or stored.
- Incident images are stored in the private Supabase Storage bucket `proctoring-incidents`, limited to JPEG files up to 1 MB.
- Admin-only event review endpoint with five-minute signed image URLs.
- Admin-only cleanup endpoint for incident snapshots whose 30-day retention timestamp has passed.

## Supabase setup

1. Open the Supabase project used by SecureTest.
2. Open **SQL Editor**.
3. Run `supabase/migrations/20261104_camera_proctoring.sql`.
4. Confirm that `exam_sessions`, `proctoring_events`, and the private `proctoring-incidents` bucket exist.
5. Confirm the Express deployment has the server-side Supabase secret configured. Never place the service-role/secret key in browser code.

The migration enables RLS on the new tables and intentionally creates no anon/authenticated policies. Express uses the server-side secret for all access.

## Runtime configuration

Keep the existing environment variables configured:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` (or the existing `SUPABASE_SERVICE_ROLE_KEY`)
- `SESSION_SECRET` – replace the repository fallback with a long random value in the host's environment.
- `ADMIN_USER` and `ADMIN_PASSWORD` – set strong production credentials.
- `NODE_ENV=production` so secure cookies are enabled.
- `DATABASE_URL` for the existing PostgreSQL-backed Express admin session store.

The browser loads MediaPipe Tasks Vision and TensorFlow.js/COCO-SSD from jsDelivr and the MediaPipe model from Google-hosted model assets. Candidate laptops need internet access to download these model assets before the examination. Camera access requires HTTPS and browser permission.

## Candidate flow

1. Candidate completes the existing registration form.
2. On the instructions page, candidate must check the camera-monitoring acknowledgement.
3. Candidate may separately opt in to incident-only snapshots. This is optional and unchecked by default.
4. On **Start assessment**, the browser requests camera permission and initializes both local AI models.
5. Only after camera and model initialization succeeds does Express create an exam session and set an HttpOnly, Secure-in-production, SameSite=Strict cookie.
6. The browser locally detects multiple faces, sustained face absence, and a phone visible in the camera frame.
7. The browser posts event metadata (and an optional incident JPEG only if snapshot consent was given) to Express.
8. Supabase RPC `record_proctoring_violation` locks the session row, applies the server-side cooldown, increments the violation count, and sets the session to `terminated` at count three.
9. Candidate answers are autosaved. On normal submission the server scores the database-saved answers. When the third accepted violation arrives, the browser immediately submits the last saved answers.

## Admin endpoints

All endpoints below require the existing admin session:

- `GET /api/admin/proctoring/events` – latest 500 events, with short-lived signed URLs for any stored snapshots.
- `POST /api/admin/proctoring/cleanup` – deletes snapshots whose `snapshot_expires_at` has passed and clears their paths from event rows.

The cleanup endpoint is manual. Schedule it periodically through a trusted scheduler if automated retention enforcement is required. Do not expose the private bucket publicly.

## Important limitations and launch checks

- Camera AI is probabilistic. It can miss partially hidden phones, mistake background people, or flag legitimate movement. It is a signal for invigilator review, not proof of misconduct.
- This module does not identify a person's identity and does not prove that the person in front of the camera is the registered candidate.
- It cannot detect a phone or ChatGPT on a second device outside the camera's field of view.
- Browser code can be modified by a technically capable candidate. Server-side session and violation state prevents simple API bypasses but does not make an unmanaged personal laptop tamper-proof. Use Safe Exam Browser or managed devices for stronger lockdown.
- Snapshot collection requires explicit opt-in. If a candidate declines snapshots, the system still runs camera detection but stores event metadata only.
- The session model currently enforces one issued session per candidate and assessment. A lost browser session should be handled by an invigilator; do not delete session rows to casually re-enable attempts.
- The exam start route still relies on the existing roll-number registration workflow. A verified college candidate roster and one-time access codes should be added before treating identity as strongly authenticated.
- Supabase Free and Render capacity have not been load-tested by this code change. Run a 150–180 candidate test, including model download, concurrent autosave, simultaneous submission and reconnection, before a live examination.
- The migration and code have not been applied to the live Supabase project or deployed. Do not point the college at this branch until migration, security review, browser compatibility checks, privacy approval and load testing are complete.

## Manual test checklist

- [ ] Run the migration on a non-production Supabase project first.
- [ ] Verify camera denial blocks exam start and creates no session.
- [ ] Verify camera permission works on supported Chrome/Edge/Safari versions over HTTPS.
- [ ] Verify snapshot checkbox is unchecked by default and no snapshot is stored without consent.
- [ ] Verify one face produces no warning.
- [ ] Verify a second face sustained in frame produces one warning, not repeated frame-by-frame warnings.
- [ ] Verify face absence must persist before an event is recorded.
- [ ] Verify phone detection requires repeated confident detections.
- [ ] Verify the third accepted event sets server session status to `terminated`.
- [ ] Verify terminated sessions cannot autosave more answers or start a second attempt.
- [ ] Verify normal submission uses server-saved answers and correct server-side scoring.
- [ ] Verify admin event endpoint requires admin authentication and snapshot URLs expire.
- [ ] Run 150–180 simulated concurrent candidates and monitor Render, Supabase database CPU/connections, storage and egress.
