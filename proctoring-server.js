const crypto = require('crypto');
const { buildLayout, displayedQuestions } = require('./lib/exam-layout');
const { finalizeSession } = require('./lib/finalize');

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  const part = header.split(';').map((x) => x.trim()).find((x) => x.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const tokenFrom = (req) => cookieValue(req, 'securetest.exam') || req.get('x-securetest-session') || '';

// Counted events are strikes (3 = termination). Review-only events are stored
// for the invigilator and never terminate an exam. The SQL function enforces
// the same split; this table is the single place to change the policy.
const EVENT_POLICY = {
  multiple_faces: true,
  phone_detected: true,
  face_missing: true,
  camera_lost: true,
  tab_hidden: true,
  window_blur: true,
  fullscreen_exit: true,
  copy_attempt: false,
  looking_away: false,
  screenshot_key: false,
  multi_monitor: false
};

function sanitizeAnswers(answers) {
  if (!Array.isArray(answers) || answers.length > 500) return null;
  return answers.map((value) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string') return value.slice(0, 4000);
    return null;
  });
}

function mountProctoring(app, deps) {
  const { supabase, getBundle, normalizeRollNumber, requireAdmin } = deps;
  const cfg = {
    shuffle: deps.shuffle !== false,
    maxViolations: Math.max(2, Number(deps.maxViolations) || 3),
    graceMs: Number(deps.graceMs) || 90000,            // late-submit window after the timer ends
    terminatedGraceMs: 60000,                          // sweeper waits this long for a terminated browser to submit
    maxSnapshotsPerSession: 12
  };

  // ---- tiny in-memory abuse guards (per exam token, NOT per IP: a whole lab
  // shares one college NAT address) ----
  const lastCall = new Map();
  const eventWindow = new Map();
  const snapshotCount = new Map();
  setInterval(() => {
    const cutoff = Date.now() - 120000;
    for (const [key, at] of lastCall) if (at < cutoff) lastCall.delete(key);
    for (const [key, list] of eventWindow) if (!list.length || list[list.length - 1] < cutoff) eventWindow.delete(key);
  }, 60000).unref();
  const tooSoon = (key, minMs) => {
    const now = Date.now();
    if (now - (lastCall.get(key) || 0) < minMs) return true;
    lastCall.set(key, now);
    return false;
  };
  const tooManyEvents = (key) => {
    const now = Date.now();
    const list = (eventWindow.get(key) || []).filter((t) => now - t < 60000);
    list.push(now);
    eventWindow.set(key, list);
    return list.length > 40;
  };

  async function findSession(req) {
    const token = tokenFrom(req);
    if (!token) return null;
    const { data, error } = await supabase.from('exam_sessions').select('*').eq('token_hash', tokenHash(token)).maybeSingle();
    if (error) throw error;
    return data;
  }

  function sessionPayload(session, bundle, extra = {}) {
    const layout = buildLayout(bundle.questions, session.id, cfg.shuffle);
    return {
      ok: true,
      sessionId: session.id,
      expiresAt: session.expires_at,
      serverTime: new Date().toISOString(),
      durationSeconds: Math.max(0, Math.ceil((new Date(session.expires_at).getTime() - Date.now()) / 1000)),
      savedAnswers: Array.isArray(session.saved_answers) ? session.saved_answers : [],
      violationCount: session.violation_count || 0,
      maxViolations: cfg.maxViolations,
      questions: displayedQuestions(bundle.questions, layout),
      ...extra
    };
  }

  function setExamCookie(res, token, durationMs) {
    res.cookie('securetest.exam', token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', path: '/', maxAge: durationMs + 600000
    });
  }

  // ------------------------------------------------------------------ start
  app.post('/api/tests/:id/start', async (req, res) => {
    try {
      const bundle = await getBundle(req.params.id);
      if (!bundle) return res.status(404).json({ error: 'Assessment not found' });
      if (!bundle.questions.length) return res.status(400).json({ error: 'This assessment has no questions yet.' });
      const test = bundle.row;
      if (req.body?.cameraReady !== true || req.body?.cameraConsent !== true) return res.status(400).json({ error: 'Camera permission and monitoring consent are required before starting.' });
      const student = req.body?.student || {};
      const fields = ['fullName', 'collegeName', 'rollNumber', 'mobileNumber', 'semester', 'branch', 'course'];
      if (fields.some((field) => !String(student[field] || '').trim())) return res.status(400).json({ error: 'Complete all candidate details before starting.' });

      const rollNumber = normalizeRollNumber(student.rollNumber);
      const mobileNumber = String(student.mobileNumber || '').replace(/\D/g, '');
      if (!/^\d{10}$/.test(mobileNumber)) return res.status(400).json({ error: 'Enter a valid 10-digit mobile number.' });

      const { data: phoneOwner, error: phoneError } = await supabase.from('students').select('id,roll_number').eq('mobile_number', mobileNumber).maybeSingle();
      if (phoneError) throw phoneError;
      if (phoneOwner && phoneOwner.roll_number !== rollNumber) return res.status(409).json({ error: 'This mobile number is already registered with another roll number.' });

      // Same browser coming back (refresh / tab closed by mistake): resume.
      const current = await findSession(req);
      if (current && current.test_id === test.id && current.roll_number === rollNumber &&
          current.status === 'active' && new Date(current.expires_at).getTime() > Date.now()) {
        return res.json(sessionPayload(current, bundle, { resumed: true }));
      }

      const { data: oldStudent, error: oldStudentError } = await supabase.from('students').select('id').eq('roll_number', rollNumber).maybeSingle();
      if (oldStudentError) throw oldStudentError;
      if (oldStudent) {
        const { data: oldAttempt, error: oldAttemptError } = await supabase.from('attempts').select('id').eq('test_id', test.id).eq('student_id', oldStudent.id).maybeSingle();
        if (oldAttemptError) throw oldAttemptError;
        if (oldAttempt) return res.status(409).json({ error: 'This candidate has already submitted this assessment.' });

        // A session exists but this browser has no cookie (crash / other browser).
        // Only an invigilator can re-open it, via "Allow resume" in the admin panel.
        const { data: existing, error: existingError } = await supabase.from('exam_sessions').select('*').eq('test_id', test.id).eq('student_id', oldStudent.id).maybeSingle();
        if (existingError) throw existingError;
        if (existing) {
          const alive = existing.status === 'active' && new Date(existing.expires_at).getTime() > Date.now();
          if (alive && existing.reissue_allowed) {
            const token = crypto.randomBytes(32).toString('hex');
            const { error: rotateError } = await supabase.from('exam_sessions')
              .update({ token_hash: tokenHash(token), reissue_allowed: false }).eq('id', existing.id).eq('status', 'active');
            if (rotateError) throw rotateError;
            setExamCookie(res, token, Math.max(60000, new Date(existing.expires_at).getTime() - Date.now()));
            return res.json(sessionPayload(existing, bundle, { resumed: true }));
          }
          return res.status(409).json({ error: alive
            ? 'An examination session is already open for this candidate. Ask the invigilator to allow you to resume.'
            : 'This candidate’s examination session has already ended. Contact the invigilator.' });
        }
      }

      const candidate = {
        fullName: String(student.fullName).trim(), collegeName: String(student.collegeName).trim(),
        rollNumber, mobileNumber, semester: String(student.semester).trim(),
        branch: String(student.branch).trim(), course: String(student.course).trim()
      };
      const { data: studentRow, error: studentError } = await supabase.from('students').upsert({
        full_name: candidate.fullName, college_name: candidate.collegeName, roll_number: rollNumber,
        mobile_number: mobileNumber, semester: candidate.semester, branch: candidate.branch,
        course: candidate.course, updated_at: new Date().toISOString()
      }, { onConflict: 'roll_number' }).select('id').single();
      if (studentError) throw studentError;

      const token = crypto.randomBytes(32).toString('hex');
      const startedAt = new Date();
      const durationMs = Math.max(1, Number(test.duration_minutes) || 10) * 60000;
      const snapshotConsent = req.body?.snapshotConsent === true;
      const { data: session, error: sessionError } = await supabase.from('exam_sessions').insert({
        test_id: test.id, student_id: studentRow.id, roll_number: rollNumber, candidate,
        token_hash: tokenHash(token), status: 'active', started_at: startedAt.toISOString(),
        expires_at: new Date(startedAt.getTime() + durationMs).toISOString(),
        camera_consent_at: startedAt.toISOString(), snapshot_consent: snapshotConsent,
        snapshot_consent_at: snapshotConsent ? startedAt.toISOString() : null,
        last_heartbeat_at: startedAt.toISOString()
      }).select('*').single();
      if (sessionError) {
        if (sessionError.code === '23505') return res.status(409).json({ error: 'An examination session already exists for this candidate.' });
        throw sessionError;
      }
      setExamCookie(res, token, durationMs);
      return res.json(sessionPayload(session, bundle));
    } catch (error) {
      console.error('Exam start failed:', error);
      return res.status(500).json({ error: 'Could not start the secure examination. Please try again or contact the invigilator.' });
    }
  });

  // Questions are only ever delivered to a holder of a live exam session.
  app.get('/api/tests/:id/questions', async (req, res) => {
    try {
      const session = await findSession(req);
      if (!session || session.test_id !== req.params.id || session.status !== 'active') return res.status(403).json({ error: 'No active examination session.' });
      const bundle = await getBundle(session.test_id);
      if (!bundle) return res.status(404).json({ error: 'Assessment not found' });
      return res.json(sessionPayload(session, bundle));
    } catch (error) {
      console.error('Question delivery failed:', error);
      return res.status(500).json({ error: 'Could not load questions.' });
    }
  });

  app.get('/api/proctoring/session', async (req, res) => {
    try {
      const session = await findSession(req);
      if (!session) return res.status(401).json({ error: 'Examination session not found.' });
      let status = session.status;
      if (status === 'active' && new Date(session.expires_at).getTime() <= Date.now()) status = 'expired';
      return res.json({
        status, violationCount: session.violation_count, maxViolations: cfg.maxViolations,
        expiresAt: session.expires_at, serverTime: new Date().toISOString(),
        snapshotConsent: session.snapshot_consent, testId: session.test_id,
        candidate: session.candidate, savedAnswers: session.saved_answers || []
      });
    } catch (error) {
      console.error('Session verification failed:', error);
      return res.status(500).json({ error: 'Could not verify examination session.' });
    }
  });

  // --------------------------------------------------------------- autosave
  // One UPDATE does validation + write (no separate SELECT).
  app.post('/api/tests/:id/answers', async (req, res) => {
    try {
      const token = tokenFrom(req);
      if (!token) return res.status(403).json({ error: 'No active examination session.' });
      const hash = tokenHash(token);
      if (tooSoon('save:' + hash, 300)) return res.status(429).json({ error: 'Saving too quickly.' });
      const safeAnswers = sanitizeAnswers(req.body?.answers);
      if (!safeAnswers) return res.status(400).json({ error: 'Invalid answer payload.' });
      const { data, error } = await supabase.from('exam_sessions')
        .update({ saved_answers: safeAnswers })
        .eq('token_hash', hash).eq('test_id', req.params.id).eq('status', 'active')
        .gt('expires_at', new Date().toISOString()).select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(403).json({ error: 'No active examination session (it may have ended).' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('Answer autosave failed:', error);
      return res.status(500).json({ error: 'Could not save answers.' });
    }
  });

  // -------------------------------------------------------------- heartbeat
  app.post('/api/proctoring/heartbeat', async (req, res) => {
    try {
      const token = tokenFrom(req);
      if (!token) return res.status(401).json({ error: 'No examination session.' });
      const hash = tokenHash(token);
      if (tooSoon('hb:' + hash, 4000)) return res.json({ ok: true, throttled: true });
      const raw = req.body?.state || {};
      const state = {
        camera: raw.camera === true, models: raw.models === true, fullscreen: raw.fullscreen === true,
        visible: raw.visible === true, monitors: raw.monitors === true,
        faults: Math.min(999, Math.max(0, Number(raw.faults) || 0))
      };
      const nowIso = new Date().toISOString();
      const { data, error } = await supabase.from('exam_sessions')
        .update({ last_heartbeat_at: nowIso, client_state: state })
        .eq('token_hash', hash).in('status', ['active', 'terminated'])
        .select('status,violation_count,expires_at').maybeSingle();
      if (error) throw error;
      if (!data) return res.status(401).json({ error: 'No examination session.' });
      const status = data.status === 'active' && new Date(data.expires_at).getTime() <= Date.now() ? 'expired' : data.status;
      return res.json({ ok: true, status, violationCount: data.violation_count, maxViolations: cfg.maxViolations, expiresAt: data.expires_at, serverTime: nowIso });
    } catch (error) {
      console.error('Heartbeat failed:', error);
      return res.status(500).json({ error: 'Heartbeat failed.' });
    }
  });

  // ----------------------------------------------------------------- events
  app.post('/api/proctoring/events', async (req, res) => {
    let uploadedPath = null;
    try {
      const token = tokenFrom(req);
      const hash = token ? tokenHash(token) : '';
      if (hash && tooManyEvents(hash)) return res.status(429).json({ error: 'Too many events.' });
      const session = await findSession(req);
      if (!session || session.status !== 'active') return res.status(403).json({ error: 'No active examination session.' });
      const eventType = String(req.body?.eventType || '');
      if (!Object.prototype.hasOwnProperty.call(EVENT_POLICY, eventType)) return res.status(400).json({ error: 'Unsupported proctoring event.' });
      const counts = EVENT_POLICY[eventType];

      const confidence = Number(req.body?.confidence);
      const details = {
        detector: String(req.body?.detector || 'browser').slice(0, 40),
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null
      };
      if (typeof req.body?.note === 'string') details.note = req.body.note.slice(0, 120);

      const used = snapshotCount.get(session.id) || 0;
      if (counts && session.snapshot_consent && used < cfg.maxSnapshotsPerSession && typeof req.body?.snapshot === 'string') {
        const prefix = 'data:image/jpeg;base64,';
        if (req.body.snapshot.startsWith(prefix)) {
          const encoded = req.body.snapshot.slice(prefix.length);
          if (/^[A-Za-z0-9+/=]+$/.test(encoded)) {
            const buffer = Buffer.from(encoded, 'base64');
            if (buffer.length > 0 && buffer.length <= 1024 * 1024) {
              uploadedPath = session.id + '/' + Date.now() + '-' + crypto.randomBytes(5).toString('hex') + '.jpg';
              const { error: uploadError } = await supabase.storage.from('proctoring-incidents')
                .upload(uploadedPath, buffer, { contentType: 'image/jpeg', upsert: false });
              if (uploadError) { console.error('Incident snapshot upload failed:', uploadError.message); uploadedPath = null; }
            }
          }
        }
      }

      const { data, error } = await supabase.rpc('record_proctoring_violation', {
        p_token_hash: hash, p_event_type: eventType, p_details: details,
        p_snapshot_path: uploadedPath, p_counts: counts, p_max: cfg.maxViolations
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      if (result?.accepted && uploadedPath) snapshotCount.set(session.id, used + 1);
      if (!result?.accepted && uploadedPath) await supabase.storage.from('proctoring-incidents').remove([uploadedPath]);
      return res.json({
        accepted: !!result?.accepted, counted: counts,
        violationCount: Number(result?.violation_count) || 0,
        maxViolations: cfg.maxViolations,
        terminated: !!result?.terminated, status: result?.session_status || session.status
      });
    } catch (error) {
      console.error('Proctoring event failed:', error);
      if (uploadedPath) await supabase.storage.from('proctoring-incidents').remove([uploadedPath]).catch(() => {});
      return res.status(500).json({ error: 'Could not record proctoring event.' });
    }
  });

  // ----------------------------------------------------------------- submit
  // Never rejects a real session: inside the grace window the candidate's final
  // answers are used, afterwards the last autosave is used. Always idempotent,
  // so the browser can safely retry through network blips at the end-of-exam burst.
  app.post('/api/tests/:id/submit', async (req, res) => {
    try {
      const session = await findSession(req);
      if (!session || session.test_id !== req.params.id) return res.status(403).json({ error: 'No valid examination session is available for submission.' });

      if (session.status === 'submitted') {
        const { data: attempt, error } = await supabase.from('attempts').select('submission_id').eq('test_id', session.test_id).eq('student_id', session.student_id).maybeSingle();
        if (error) throw error;
        res.clearCookie('securetest.exam', { path: '/' });
        return res.json({ ok: true, submissionId: attempt?.submission_id || null, message: 'Test already submitted.', terminated: false });
      }
      const bundle = await getBundle(session.test_id);
      if (!bundle) return res.status(404).json({ error: 'Assessment not found' });

      const inGrace = Date.now() <= new Date(session.expires_at).getTime() + cfg.graceMs;
      const clientAnswers = sanitizeAnswers(req.body?.answers);
      if (req.body?.answers !== undefined && !clientAnswers) return res.status(400).json({ error: 'Invalid answer payload.' });
      if (clientAnswers && clientAnswers.length > bundle.questions.length) return res.status(400).json({ error: 'Invalid answer payload.' });
      const answers = inGrace && clientAnswers ? clientAnswers : (session.saved_answers || []);

      const result = await finalizeSession({ supabase, session, bundle, answers, shuffle: cfg.shuffle });
      res.clearCookie('securetest.exam', { path: '/' });
      return res.json({
        ok: true, submissionId: result.submissionId, message: 'Test submitted successfully.',
        terminated: session.status === 'terminated', late: !inGrace
      });
    } catch (error) {
      console.error('Submit failed:', error);
      return res.status(500).json({ error: 'Could not submit assessment. Please retry.' });
    }
  });

  // ------------------------------------------------------------------ admin
  app.get('/api/admin/proctoring/events', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('proctoring_events')
        .select('id,event_type,violation_number,counted,details,snapshot_path,created_at,exam_sessions(test_id,roll_number,candidate,snapshot_consent)')
        .order('created_at', { ascending: false }).limit(500);
      if (error) throw error;
      const events = await Promise.all((data || []).map(async (event) => {
        let snapshotUrl = null;
        if (event.snapshot_path) {
          const { data: signed, error: signedError } = await supabase.storage.from('proctoring-incidents').createSignedUrl(event.snapshot_path, 300);
          if (!signedError) snapshotUrl = signed?.signedUrl || null;
        }
        return { ...event, snapshotUrl };
      }));
      return res.json({ events });
    } catch (error) {
      console.error('Admin proctoring event query failed:', error);
      return res.status(500).json({ error: 'Could not load proctoring events.' });
    }
  });

  // Live invigilator view of everyone currently sitting the exam.
  app.get('/api/admin/proctoring/live', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('exam_sessions')
        .select('id,test_id,roll_number,candidate,status,violation_count,started_at,expires_at,last_heartbeat_at,client_state,reissue_allowed')
        .in('status', ['active', 'terminated']).order('started_at', { ascending: false }).limit(500);
      if (error) throw error;
      const sessions = data || [];
      const flags = new Map();
      if (sessions.length) {
        const { data: soft, error: softError } = await supabase.from('proctoring_events')
          .select('session_id').eq('counted', false).in('session_id', sessions.map((s) => s.id));
        if (softError) throw softError;
        (soft || []).forEach((row) => flags.set(row.session_id, (flags.get(row.session_id) || 0) + 1));
      }
      const now = Date.now();
      return res.json({
        serverTime: new Date(now).toISOString(), maxViolations: cfg.maxViolations,
        sessions: sessions.map((s) => ({
          id: s.id, name: s.candidate?.fullName || '', roll: s.roll_number, testId: s.test_id,
          status: s.status, violations: s.violation_count, reviewFlags: flags.get(s.id) || 0,
          heartbeatAgeSec: s.last_heartbeat_at ? Math.round((now - new Date(s.last_heartbeat_at).getTime()) / 1000) : null,
          secondsLeft: Math.max(0, Math.round((new Date(s.expires_at).getTime() - now) / 1000)),
          clientState: s.client_state || {}, resumeAllowed: !!s.reissue_allowed
        }))
      });
    } catch (error) {
      console.error('Live monitor query failed:', error);
      return res.status(500).json({ error: 'Could not load live sessions.' });
    }
  });

  app.post('/api/admin/proctoring/sessions/:id/allow-resume', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('exam_sessions').update({ reissue_allowed: true })
        .eq('id', req.params.id).eq('status', 'active').select('id');
      if (error) throw error;
      if (!data || !data.length) return res.status(404).json({ error: 'No active session with that id.' });
      return res.json({ ok: true });
    } catch (error) {
      console.error('Allow-resume failed:', error);
      return res.status(500).json({ error: 'Could not update session.' });
    }
  });

  app.post('/api/admin/proctoring/cleanup', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('proctoring_events')
        .select('id,snapshot_path').not('snapshot_path', 'is', null).lt('snapshot_expires_at', new Date().toISOString());
      if (error) throw error;
      const rows = data || [];
      const paths = rows.map((row) => row.snapshot_path).filter(Boolean);
      if (paths.length) {
        const { error: removeError } = await supabase.storage.from('proctoring-incidents').remove(paths);
        if (removeError) throw removeError;
        const { error: updateError } = await supabase.from('proctoring_events').update({ snapshot_path: null }).in('id', rows.map((row) => row.id));
        if (updateError) throw updateError;
      }
      return res.json({ ok: true, deletedSnapshots: paths.length });
    } catch (error) {
      console.error('Proctoring retention cleanup failed:', error);
      return res.status(500).json({ error: 'Could not clean up expired incident snapshots.' });
    }
  });

  // ---------------------------------------------------------------- sweeper
  // Grades sessions nobody submitted (closed browser, dead laptop, ended timer
  // with a lost connection) from their last autosave, so no attempt is lost.
  let sweeping = false;
  async function sweepOnce() {
    if (sweeping) return { skipped: true };
    sweeping = true;
    let finalized = 0;
    try {
      const timerCutoff = new Date(Date.now() - cfg.graceMs).toISOString();
      const terminatedCutoff = new Date(Date.now() - cfg.terminatedGraceMs).toISOString();
      const [timedOut, terminated] = await Promise.all([
        supabase.from('exam_sessions').select('*').in('status', ['active', 'expired']).lt('expires_at', timerCutoff).limit(50),
        supabase.from('exam_sessions').select('*').eq('status', 'terminated').lt('last_event_at', terminatedCutoff).limit(50)
      ]);
      if (timedOut.error) throw timedOut.error;
      if (terminated.error) throw terminated.error;
      const queue = [...(timedOut.data || []), ...(terminated.data || [])];
      for (let i = 0; i < queue.length; i += 5) {
        await Promise.all(queue.slice(i, i + 5).map(async (session) => {
          try {
            const bundle = await getBundle(session.test_id);
            if (!bundle) return;
            await finalizeSession({ supabase, session, bundle, answers: session.saved_answers || [], shuffle: cfg.shuffle });
            finalized += 1;
          } catch (error) {
            console.error('Sweeper could not finalize session', session.id, error.message || error);
          }
        }));
      }
    } catch (error) {
      console.error('Sweeper run failed:', error.message || error);
    } finally {
      sweeping = false;
    }
    return { finalized };
  }
  function startSweeper(intervalMs = 30000) {
    const timer = setInterval(sweepOnce, intervalMs);
    timer.unref();
    return timer;
  }

  return { sweepOnce, startSweeper, config: cfg };
}

module.exports = mountProctoring;
module.exports.EVENT_POLICY = EVENT_POLICY;
