const crypto = require('crypto');

function cookieValue(req, name) {
  const header = req.headers.cookie || '';
  const part = header.split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : '';
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function mountProctoring(app, { supabase, getTest, normalizeRollNumber, requireAdmin }) {
  async function findSession(req) {
    const token = cookieValue(req, 'securetest.exam') || req.get('x-securetest-session');
    if (!token) return null;
    const { data, error } = await supabase.from('exam_sessions')
      .select('*').eq('token_hash', tokenHash(token)).maybeSingle();
    if (error) throw error;
    return data;
  }

  app.post('/api/tests/:id/start', async (req, res) => {
    try {
      const test = await getTest(req.params.id);
      if (!test) return res.status(404).json({ error: 'Assessment not found' });
      if (req.body?.cameraReady !== true || req.body?.cameraConsent !== true) return res.status(400).json({ error: 'Camera permission and monitoring consent are required before starting.' });
      const student = req.body?.student || {};
      const fields = ['fullName','collegeName','rollNumber','mobileNumber','semester','branch','course'];
      if (fields.some(field => !String(student[field] || '').trim())) return res.status(400).json({ error: 'Complete all candidate details before starting.' });

      const rollNumber = normalizeRollNumber(student.rollNumber);
      const { data: oldStudent, error: oldStudentError } = await supabase.from('students')
        .select('id').eq('roll_number', rollNumber).maybeSingle();
      if (oldStudentError) throw oldStudentError;
      if (oldStudent) {
        const { data: oldAttempt, error: oldAttemptError } = await supabase.from('attempts')
          .select('id').eq('test_id', test.id).eq('student_id', oldStudent.id).maybeSingle();
        if (oldAttemptError) throw oldAttemptError;
        if (oldAttempt) return res.status(409).json({ error: 'This candidate has already submitted this assessment.' });
      }

      const candidate = {
        fullName: String(student.fullName).trim(),
        collegeName: String(student.collegeName).trim(),
        rollNumber,
        mobileNumber: String(student.mobileNumber).trim(),
        semester: String(student.semester).trim(),
        branch: String(student.branch).trim(),
        course: String(student.course).trim()
      };
      const { data: studentRow, error: studentError } = await supabase.from('students').upsert({
        full_name: candidate.fullName, college_name: candidate.collegeName,
        roll_number: rollNumber, mobile_number: candidate.mobileNumber,
        semester: candidate.semester, branch: candidate.branch,
        course: candidate.course, updated_at: new Date().toISOString()
      }, { onConflict: 'roll_number' }).select('id').single();
      if (studentError) throw studentError;

      const token = crypto.randomBytes(32).toString('hex');
      const startedAt = new Date();
      const durationMs = Math.max(1, Number(test.duration_minutes) || 10) * 60000;
      const expiresAt = new Date(startedAt.getTime() + durationMs);
      const snapshotConsent = req.body?.snapshotConsent === true;
      const { data: session, error: sessionError } = await supabase.from('exam_sessions').insert({
        test_id: test.id, student_id: studentRow.id, roll_number: rollNumber,
        candidate, token_hash: tokenHash(token), status: 'active',
        started_at: startedAt.toISOString(), expires_at: expiresAt.toISOString(),
        camera_consent_at: startedAt.toISOString(), snapshot_consent: snapshotConsent,
        snapshot_consent_at: snapshotConsent ? startedAt.toISOString() : null
      }).select('id,expires_at').single();
      if (sessionError) {
        if (sessionError.code === '23505') return res.status(409).json({ error: 'An active examination session already exists for this candidate.' });
        throw sessionError;
      }

      res.cookie('securetest.exam', token, {
        httpOnly: true, secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict', path: '/', maxAge: durationMs + 600000
      });
      return res.json({
        ok: true, sessionId: session.id, expiresAt: session.expires_at,
        durationSeconds: Math.floor(durationMs / 1000)
      });
    } catch (error) {
      console.error('Exam start failed:', error);
      return res.status(500).json({ error: 'Could not start the secure examination. Please contact the invigilator.' });
    }
  });

  app.get('/api/proctoring/session', async (req, res) => {
    try {
      const session = await findSession(req);
      if (!session) return res.status(401).json({ error: 'Examination session not found.' });
      return res.json({
        status: session.status, violationCount: session.violation_count,
        expiresAt: session.expires_at, snapshotConsent: session.snapshot_consent
      });
    } catch (error) {
      console.error('Session verification failed:', error);
      return res.status(500).json({ error: 'Could not verify examination session.' });
    }
  });

  app.post('/api/tests/:id/answers', async (req, res) => {
    try {
      const session = await findSession(req);
      if (!session || session.test_id !== req.params.id || session.status !== 'active') {
        return res.status(403).json({ error: 'No active examination session.' });
      }
      if (new Date(session.expires_at).getTime() <= Date.now()) {
        await supabase.from('exam_sessions').update({ status: 'expired' }).eq('id', session.id);
        return res.status(410).json({ error: 'Examination time has expired.' });
      }
      const answers = req.body?.answers;
      if (!Array.isArray(answers) || answers.length > 500) return res.status(400).json({ error: 'Invalid answer payload.' });
      const safeAnswers = answers.map(value => {
        if (value === null || value === undefined) return null;
        if (typeof value === 'number' && Number.isInteger(value)) return value;
        if (typeof value === 'string') return value.slice(0, 4000);
        return null;
      });
      const { error } = await supabase.from('exam_sessions')
        .update({ saved_answers: safeAnswers }).eq('id', session.id).eq('status', 'active');
      if (error) throw error;
      return res.json({ ok: true });
    } catch (error) {
      console.error('Answer autosave failed:', error);
      return res.status(500).json({ error: 'Could not save answers.' });
    }
  });

  app.post('/api/proctoring/events', async (req, res) => {
    let uploadedPath = null;
    try {
      const session = await findSession(req);
      if (!session || session.status !== 'active') return res.status(403).json({ error: 'No active examination session.' });
      const allowed = ['multiple_faces','face_missing','phone_detected','tab_hidden','window_blur','fullscreen_exit','copy_attempt'];
      const eventType = String(req.body?.eventType || '');
      if (!allowed.includes(eventType)) return res.status(400).json({ error: 'Unsupported proctoring event.' });

      const details = {
        detector: String(req.body?.detector || 'browser').slice(0, 40),
        confidence: Number.isFinite(Number(req.body?.confidence))
          ? Math.max(0, Math.min(1, Number(req.body.confidence))) : null
      };

      if (session.snapshot_consent && typeof req.body?.snapshot === 'string') {
        const prefix = 'data:image/jpeg;base64,';
        if (req.body.snapshot.startsWith(prefix)) {
          const encoded = req.body.snapshot.slice(prefix.length);
          if (/^[A-Za-z0-9+/=]+$/.test(encoded)) {
            const buffer = Buffer.from(encoded, 'base64');
            if (buffer.length > 0 && buffer.length <= 1024 * 1024) {
              uploadedPath = session.id + '/' + Date.now() + '-' + crypto.randomBytes(5).toString('hex') + '.jpg';
              const { error: uploadError } = await supabase.storage.from('proctoring-incidents')
                .upload(uploadedPath, buffer, { contentType: 'image/jpeg', upsert: false });
              if (uploadError) {
                console.error('Incident snapshot upload failed:', uploadError.message);
                uploadedPath = null;
              }
            }
          }
        }
      }

      const token = cookieValue(req, 'securetest.exam') || req.get('x-securetest-session') || '';
      const { data, error } = await supabase.rpc('record_proctoring_violation', {
        p_token_hash: tokenHash(token),
        p_event_type: eventType,
        p_details: details,
        p_snapshot_path: uploadedPath
      });
      if (error) throw error;
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.accepted && uploadedPath) {
        await supabase.storage.from('proctoring-incidents').remove([uploadedPath]);
      }
      return res.json({
        accepted: !!result?.accepted,
        violationCount: Number(result?.violation_count) || 0,
        terminated: !!result?.terminated,
        status: result?.session_status || session.status
      });
    } catch (error) {
      console.error('Proctoring event failed:', error);
      if (uploadedPath) await supabase.storage.from('proctoring-incidents').remove([uploadedPath]).catch(() => {});
      return res.status(500).json({ error: 'Could not record proctoring event.' });
    }
  });

  app.get('/api/admin/proctoring/events', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('proctoring_events')
        .select('id,event_type,violation_number,details,snapshot_path,created_at,exam_sessions(test_id,roll_number,candidate)')
        .order('created_at', { ascending: false }).limit(500);
      if (error) throw error;
      const events = await Promise.all((data || []).map(async event => {
        let snapshotUrl = null;
        if (event.snapshot_path) {
          const { data: signed, error: signedError } = await supabase.storage
            .from('proctoring-incidents').createSignedUrl(event.snapshot_path, 300);
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

  app.post('/api/admin/proctoring/cleanup', requireAdmin, async (req, res) => {
    try {
      const now = new Date().toISOString();
      const { data, error } = await supabase.from('proctoring_events')
        .select('id,snapshot_path').not('snapshot_path', 'is', null).lt('snapshot_expires_at', now);
      if (error) throw error;
      const rows = data || [];
      const paths = rows.map(row => row.snapshot_path).filter(Boolean);
      if (paths.length) {
        const { error: removeError } = await supabase.storage.from('proctoring-incidents').remove(paths);
        if (removeError) throw removeError;
        const ids = rows.map(row => row.id);
        const { error: updateError } = await supabase.from('proctoring_events')
          .update({ snapshot_path: null }).in('id', ids);
        if (updateError) throw updateError;
      }
      return res.json({ ok: true, deletedSnapshots: paths.length });
    } catch (error) {
      console.error('Proctoring retention cleanup failed:', error);
      return res.status(500).json({ error: 'Could not clean up expired incident snapshots.' });
    }
  });

  // This middleware runs before the legacy submit route, so direct API calls
  // cannot submit without a server-issued, unexpired exam session.
  app.use('/api/tests/:id/submit', async (req, res, next) => {
    try {
      const session = await findSession(req);
      if (!session || session.test_id !== req.params.id || !['active','terminated'].includes(session.status)) {
        return res.status(403).json({ error: 'No valid examination session is available for submission.' });
      }
      if (session.status === 'active' && new Date(session.expires_at).getTime() <= Date.now()) {
        await supabase.from('exam_sessions').update({ status: 'expired' }).eq('id', session.id);
        return res.status(410).json({ error: 'Examination time has expired.' });
      }
      req.examSession = session;
      return next();
    } catch (error) {
      console.error('Submission session validation failed:', error);
      return res.status(500).json({ error: 'Could not validate examination session.' });
    }
  });
}

module.exports = mountProctoring;
