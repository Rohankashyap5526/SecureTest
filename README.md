# 🛡️ SecureTest

> Secure online assessment platform built with Express and Supabase PostgreSQL.

## ✨ Features

- Student and admin interfaces
- Candidate registration
- One-attempt restriction per roll number and assessment
- Server-side scoring
- MCQ and code-output questions
- Full-screen exam mode
- Violation detection
- Admin-only results
- Excel result export
- Supabase PostgreSQL persistence
- Render deployment support

## 🏗️ Architecture

~~~text
Student / Admin
      ↓
Web UI
      ↓
Express Server
      ↓
Supabase PostgreSQL
      ↓
Tests + Results
~~~

## 🧰 Tech Stack

- Node.js
- Express
- Supabase PostgreSQL
- JavaScript
- HTML / CSS
- Excel export
- Render

## 🚀 Local Setup

~~~bash
git clone https://github.com/Rohankashyap5526/SecureTest.git
cd SecureTest
npm install
~~~

Create `.env` from `.env.example`:

~~~env
NODE_ENV=development
SUPABASE_URL=your_project_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SESSION_SECRET=your_random_secret
ADMIN_USER=your_admin_username
ADMIN_PASSWORD=your_admin_password
~~~

Run:

~~~bash
npm start
~~~

Open `http://localhost:3000`.

## 🗄️ Database

Run the SQL schema in `supabase/schema.sql` and configure Supabase before starting the application.

## 🚀 Deployment

The application can be deployed as a Render Web Service.

Build command: `npm install`  
Start command: `npm start`

Configure all required environment variables in the deployment platform.

## 🔐 Production Security

- Never commit `.env`.
- Never expose the Supabase service-role key to frontend code.
- Use a strong session secret and admin password.
- Use HTTPS in production.
- For multiple server instances, use a persistent session store instead of the default memory store.

## 📌 Future Improvements

- Automated integration tests
- Redis-backed sessions
- Question import workflow
- Detailed analytics dashboard
- Role-based admin permissions

## 📄 License

MIT

## Camera Proctoring (security-hardening branch)

The `security-hardening` branch includes local camera-based face/phone detection, server-side warning enforcement, optional incident-only snapshots with separate consent, and server-persisted answer autosave. Before testing, run `supabase/migrations/20261104_camera_proctoring.sql` in the Supabase SQL Editor. See [Camera Proctoring Setup](docs/CAMERA_PROCTORING_SETUP.md) for configuration, privacy notes, admin endpoints, limitations and the 150-student launch checklist. This branch has not been deployed.
