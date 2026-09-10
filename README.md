# SecureTest — Supabase + Render Deployment

SecureTest is an Express-based online assessment platform. This version stores assessments and student results in Supabase PostgreSQL instead of local JSON files, making it suitable for deployment on Render.

## Features

- Professional student/admin UI
- Candidate registration with university/college and roll number
- One-attempt rule per roll number + assessment
- Server-side scoring
- Correct handling of unanswered questions
- MCQ questions
- Code-output questions with server-side expected output
- Full-screen exam mode and violation detection
- Admin-only results
- Excel export
- Clean client-side routes
- Supabase PostgreSQL persistence

## 1. Create Supabase project

Create a project at https://supabase.com/.

Open **SQL Editor** and run:

`supabase/schema.sql`

The database has two private tables: `tests` and `results`. Row Level Security is enabled and no public policies are created because only the Express server should access these tables.

## 2. Get Supabase credentials

From your Supabase project settings/API page, copy:

- Project URL → `SUPABASE_URL`
- Service role key → `SUPABASE_SERVICE_ROLE_KEY`

**Never put the service role key in frontend JavaScript or GitHub.**

## 3. Local setup

```bash
npm install
```

Create `.env` from `.env.example` and fill in the values.

Then seed the sample Cloud Computing assessment:

```bash
npm run seed
```

Start:

```bash
npm start
```

Open `http://localhost:3000`.

## 4. Render deployment

Push this folder to GitHub, then create a **Web Service** on Render.

Build command:

```text
npm install
```

Start command:

```text
npm start
```

Add these Render environment variables:

```text
NODE_ENV=production
SUPABASE_URL=your_supabase_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SESSION_SECRET=long_random_secret
ADMIN_USER=your_admin_username
ADMIN_PASSWORD=your_strong_admin_password
```

Deploy the service.

After deployment, seed the sample test once. You can run `npm run seed` locally using the same Supabase credentials, or use Render's shell if available for your service.

## Important production notes

1. Do not commit `.env` or the Supabase service-role key.
2. Change the default admin password.
3. Use a long random `SESSION_SECRET`.
4. HTTPS is required in production; the session cookie automatically uses `secure=true` when `NODE_ENV=production`.
5. The default Express MemoryStore is suitable for a small/demo deployment but is not a persistent multi-instance session store. For multiple server instances, use a persistent session store such as Redis.
6. The database is the source of truth. Local JSON files are no longer used for tests/results.
7. Excel is generated from the database on demand and is an export, not the primary database.

## Default sample test

The included `seed-tests.json` contains **Cloud Computing Fundamentals** with 11 questions, including one code-output question.
