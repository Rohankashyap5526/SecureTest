// Minimal in-memory stand-in for the parts of supabase-js that SecureTest uses.
// It exists so the real Express app can be exercised (and load-simulated)
// without a database. It mirrors the unique constraints and the
// record_proctoring_violation SQL function.
const crypto = require('crypto');

const UNIQUES = {
  students: [['roll_number'], ['mobile_number']],
  attempts: [['test_id', 'student_id']],
  exam_sessions: [['token_hash'], ['test_id', 'student_id']],
  tests: [['id']]
};

function createFakeSupabase(seed = {}) {
  const tables = { tests: [], questions: [], students: [], attempts: [], answers: [], exam_sessions: [], proctoring_events: [] };
  Object.entries(seed).forEach(([k, v]) => { tables[k] = v.map((r) => ({ ...r })); });
  const stats = { queries: 0 };

  class Query {
    constructor(table) { this.table = table; this.op = 'select'; this.filters = []; this.limitN = null; this.orderBy = null; this.mode = null; this.returning = false; }
    select() { if (this.op !== 'select') this.returning = true; return this; }
    insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, opts) { this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.onConflict = opts?.onConflict; return this; }
    update(values) { this.op = 'update'; this.payload = values; return this; }
    delete() { this.op = 'delete'; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    lt(c, v) { this.filters.push((r) => r[c] != null && r[c] < v); return this; }
    gt(c, v) { this.filters.push((r) => r[c] != null && r[c] > v); return this; }
    not(c, op, v) { if (op === 'is' && v === null) this.filters.push((r) => r[c] != null); return this; }
    order(c, o = {}) { this.orderBy = [c, o.ascending !== false]; return this; }
    limit(n) { this.limitN = n; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    // supabase-js .single() errors unless exactly one row
    single() { this.mode = 'one'; return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }

    matches() { return tables[this.table].filter((r) => this.filters.every((f) => f(r))); }
    conflict(row, ignore) {
      return (UNIQUES[this.table] || []).some((cols) => tables[this.table].some((o) => o !== ignore && cols.every((c) => o[c] === row[c] && row[c] !== undefined)));
    }
    finish(rows) {
      let out = rows;
      if (this.orderBy) { const [c, asc] = this.orderBy; out = out.slice().sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1)); }
      if (this.limitN != null) out = out.slice(0, this.limitN);
      out = out.map((r) => ({ ...r }));
      if (this.mode === 'maybe') {
        if (out.length > 1) return { data: null, error: { message: 'multiple rows' } };
        return { data: out[0] || null, error: null };
      }
      if (this.mode === 'one') {
        if (out.length !== 1) return { data: null, error: { message: 'no single row' } };
        return { data: out[0], error: null };
      }
      return { data: out, error: null };
    }
    run() {
      stats.queries += 1;
      const rows = tables[this.table];
      if (this.op === 'select') return this.finish(this.matches());
      if (this.op === 'insert') {
        const created = [];
        for (const p of this.payload) {
          const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...p };
          if (this.table === 'exam_sessions') Object.assign(row, { violation_count: 0, saved_answers: [], client_state: {}, reissue_allowed: false, ...p });
          if (this.conflict(row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          rows.push(row); created.push(row);
        }
        return this.returning ? this.finish(created) : { data: null, error: null };
      }
      if (this.op === 'upsert') {
        const key = this.onConflict;
        const out = [];
        for (const p of this.payload) {
          const existing = rows.find((r) => r[key] === p[key]);
          if (existing) { Object.assign(existing, p); out.push(existing); }
          else {
            const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...p };
            if (this.conflict(row)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
            rows.push(row); out.push(row);
          }
        }
        return this.returning ? this.finish(out) : { data: null, error: null };
      }
      if (this.op === 'update') {
        const hit = this.matches();
        hit.forEach((r) => Object.assign(r, this.payload));
        return this.returning ? this.finish(hit) : { data: null, error: null };
      }
      if (this.op === 'delete') {
        const hit = new Set(this.matches());
        tables[this.table] = rows.filter((r) => !hit.has(r));
        return this.returning ? this.finish([...hit]) : { data: null, error: null };
      }
      return { data: null, error: { message: 'unsupported' } };
    }
  }
  const objects = new Map();
  const client = {
    tables, stats,
    from: (name) => { if (!tables[name]) tables[name] = []; return new Query(name); },
    storage: {
      from: () => ({
        upload: async (p, buf) => { objects.set(p, buf); return { error: null }; },
        remove: async (paths) => { paths.forEach((p) => objects.delete(p)); return { error: null }; },
        createSignedUrl: async (p) => ({ data: { signedUrl: 'https://example.invalid/' + p }, error: null })
      })
    },
    rpc: async (name, a) => {
      stats.queries += 1;
      if (name !== 'record_proctoring_violation') return { data: null, error: { message: 'unknown rpc' } };
      const s = tables.exam_sessions.find((r) => r.token_hash === a.p_token_hash);
      const mk = (accepted, count, term, status) => ({ data: [{ accepted, violation_count: count, terminated: term, session_status: status }], error: null });
      if (!s) return mk(false, 0, false, 'not_found');
      if (s.status !== 'active' || s.expires_at <= new Date().toISOString()) return mk(false, s.violation_count, false, s.status);
      const now = Date.now();
      if (a.p_counts) {
        if (s.last_event_at && new Date(s.last_event_at).getTime() > now - 5000) return mk(false, s.violation_count, false, s.status);
        s.violation_count += 1; s.last_event_at = new Date(now).toISOString();
        s.status = s.violation_count >= a.p_max ? 'terminated' : 'active';
        tables.proctoring_events.push({ id: crypto.randomUUID(), session_id: s.id, event_type: a.p_event_type, violation_number: s.violation_count, counted: true, details: a.p_details, snapshot_path: a.p_snapshot_path, created_at: new Date(now).toISOString() });
        return mk(true, s.violation_count, s.status === 'terminated', s.status);
      }
      const recent = tables.proctoring_events.some((e) => e.session_id === s.id && e.event_type === a.p_event_type && new Date(e.created_at).getTime() > now - 10000);
      if (recent) return mk(false, s.violation_count, false, s.status);
      tables.proctoring_events.push({ id: crypto.randomUUID(), session_id: s.id, event_type: a.p_event_type, violation_number: s.violation_count, counted: false, details: a.p_details, snapshot_path: a.p_snapshot_path, created_at: new Date(now).toISOString() });
      return mk(true, s.violation_count, false, s.status);
    }
  };
  return client;
}

module.exports = { createFakeSupabase };
