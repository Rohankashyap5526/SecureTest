# Scale & Proctoring v2

Goal: ~150 candidates sit one assessment at the same moment, camera and cheating detection behave correctly.

## 1. Deploy steps
1. Supabase SQL editor: run `supabase/migrations/20261105_scale_and_proctoring_v2.sql` (after `20261104_camera_proctoring.sql`). It replaces the old 4-argument `record_proctoring_violation`; deploy the new code and the SQL together.
2. Environment (production): `SESSION_SECRET`, `ADMIN_PASSWORD` are now **mandatory** (the server refuses to start with the old defaults). Optional: `MAX_VIOLATIONS` (default 3), `SHUFFLE_QUESTIONS=false` to turn per-candidate shuffling off, `DATABASE_URL` for admin sessions.
3. Hosting: use an always-on instance (no free-tier sleep / cold start). One Node instance is enough for 150 candidates; the in-memory cache and abuse guards assume a single instance, with 60 s staleness if you run several.
4. Run `npm run loadtest` against a **staging** copy (see below) before the real exam.

## 2. What changed for scale
| Problem in the old code | Fix |
| --- | --- |
| Every visitor downloaded every question of every test (`/api/tests`) | List returns metadata only; questions are sent only inside the `/start` response (and `/questions` for resume) to a holder of a live session |
| Every request re-read tests + questions from Supabase | 60 s single-flight cache, cleared on any admin save/delete (150 simultaneous openers = 1 DB read) |
| End-of-exam timer fires for everyone at once; submit after the server deadline got **HTTP 410 and the attempt was lost** | Submit never rejects a real session: 90 s grace uses the candidate's final answers, afterwards the last autosave is graded. Idempotent, so the browser retries with jittered back-off |
| Closed browser / dead laptop = no attempt | 30 s background sweeper grades expired and terminated-but-unsubmitted sessions from their autosave |
| Submit did ~7 queries (re-read test, questions, student upsert…) | 3 queries (attempt, answers, session) using cached data |
| Autosave = select + update every 450 ms | One conditional UPDATE, 1.2 s debounce, retry/back-off, flushed when the tab hides |
| Timer counted down locally | Timer derives from the server `expiresAt`; heartbeat re-syncs it |
| Editing an assessment mid-exam silently re-ids questions | Blocked (409) while sessions are active |
| Admin login: no brute-force limit, default password, username pre-filled | Rate-limited, constant-time compare, mandatory env secrets, no pre-fill |
| Hard refresh on `/admin/...` loaded `index.html` as JS/CSS | Asset URLs are absolute |

Measured locally with the in-memory harness (`npm test`): 150 candidates start → answer → submit concurrently, ≈14 database calls each (~2,100 total), all 150 attempts stored and scored correctly. This validates application logic, **not** Supabase latency: do the staging load test.

## 3. Cheating prevention / detection changes
Strike policy (server decides, one table in `proctoring-server.js` → `EVENT_POLICY`):

* **Strikes (3 = terminated):** `multiple_faces`, `phone_detected`, `face_missing`, `camera_lost`, `tab_hidden`, `window_blur`, `fullscreen_exit`. One physical action (Alt-Tab fires tab-hidden + blur + fullscreen-exit together) now counts **once** (5 s collapse window, in SQL).
* **Review-only flags (shown to the invigilator, never terminate):** `looking_away`, `copy_attempt` (copy/paste/right-click/devtools keys), `screenshot_key`, `multi_monitor`. Previously a stray Ctrl+A or right-click cost a strike.

Detection bugs fixed:
* Unplugging / blocking / disabling the camera was never noticed → `camera_lost` strike (plus automatic re-acquire).
* Any second detected face was a strike, even a poster or a person far behind → second face must be ≥20 % of the main face area for ~2 s.
* Phone threshold 0.68 missed most phones → 0.55 with 2 consecutive hits. Real confidences are now sent (were hard-coded).
* Pre-exam check: exam will not start unless exactly one face is visible (proves camera + detector work).
* Models are preloaded while the candidate reads the instructions, retried with jitter, GPU→CPU fallback, MediaPipe imported from its explicit `.mjs` file; `stop()` no longer destroys loaded models (a retry after a failed start used to crash).
* Heartbeat every 20 s reports camera/model/fullscreen/monitor state; the admin **Live monitor** (Proctoring tab) flags "no signal", "camera off", "detector off", "2nd monitor".
* Every candidate gets their own question order and option order (deterministic from the session id, so resume is identical; "All of the above" style questions keep option order). Neighbours cannot compare screens.
* Violations are retried on network errors instead of silently dropped.

Invigilator tools: **Allow resume** button (candidate lost their cookie / switched browser); live table refreshes every 10 s.

## 4. Load test
```
# staging Supabase project with the same schema + migrations and one assessment
BASE_URL=https://staging.example.com TEST_ID=TEST-123 COUNT=150 RAMP_MS=20000 npm run loadtest
```
Prints p50/p95 latency per step and failures, then the SQL to delete the `SIM-*` data. Ten runs with `ID_OFFSET=150` etc. give different candidates.

Other tests: `npm test` (unit + 150-candidate simulation on an in-memory DB), `python3 test/browser_smoke.py` (real Chromium + fake webcam + stubbed models: every detection rule end to end).

## 5. Limits you should know about (not solved by code)
* The AI checks run in the candidate's browser. A technical student can tamper with them; the heartbeat/"no signal" view and snapshots are there so that an invigilator notices. Treat all flags as signals for human review.
* Virtual cameras (OBS), a second device out of frame, or someone helping from behind the screen are not detectable. Keep invigilators in the room.
* Identity is roll number + mobile only. Consider an exam-room access code or a roster upload if remote joining is a concern.
* Face/phone accuracy depends on the real MediaPipe/COCO-SSD models and the lab's lighting; the automated tests stub the models. Do a 10-laptop dry run in the real lab, and tune `TUNING` at the top of `public/proctoring.js`.
* Network: 150 laptops download ~15 MB of models from jsDelivr / Google storage on first use. Make sure the lab firewall allows `cdn.jsdelivr.net` and `storage.googleapis.com`, or open the instructions page 10 minutes early (models are preloaded there).
* Many candidates behind one college NAT share an IP: the server deliberately has no per-IP limit on exam endpoints.
