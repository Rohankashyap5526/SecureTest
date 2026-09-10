const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tests = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-tests.json'), 'utf8'));

(async () => {
  const rows = tests.map((t) => ({
    id: String(t.id),
    title: String(t.title || '').trim(),
    description: String(t.description || '').trim(),
    duration_minutes: Math.max(1, Number(t.durationMinutes) || 10),
    questions: Array.isArray(t.questions) ? t.questions : []
  }));

  const { error } = await supabase.from('tests').upsert(rows, { onConflict: 'id' });
  if (error) throw error;
  console.log(`Seeded ${rows.length} assessment(s).`);
})().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
