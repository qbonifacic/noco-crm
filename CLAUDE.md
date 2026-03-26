# noco-crm

## Project Overview
Express.js-based AI outreach CRM for lead management, email campaigns, and enrichment. Connects to PostgreSQL, handles bulk operations, and supports email templating with session-based authentication.

## Tech Stack
- **Backend**: Node.js 22.5+, Express.js
- **Database**: PostgreSQL
- **Auth**: bcryptjs password hashing, express-session
- **Email**: Nodemailer
- **CSV**: csv-parse for lead imports
- **Other**: CORS, session middleware

## Architecture
- server.js — Main Express app, route definitions, middleware setup
- /api/login, /api/logout, /api/me — Session auth endpoints
- /api/leads* — CRUD operations, bulk status updates
- /api/enrich — External enrichment API calls
- /api/send-email* — Email templating and batch sending
- /api/stats — Dashboard metrics
- public/ — Static frontend files
- node_modules/ — Dependencies (pg, express, nodemailer, etc.)
- Data flow: Express routes → PostgreSQL queries → Nodemailer

## Build & Test Commands
Install deps: npm install
Run dev server (default :3000): npm start
Check what's running: ps aux | grep node
Kill and restart: pkill node && npm start

## Coding Rules
- ALWAYS use full file replacements, never incremental edits
- Security-first: no credentials in code, use .env file
- All protected routes use requireAuth middleware
- Bulk operations (send-batch, bulk-status) must validate user ownership
- Email sending should be queued/logged to prevent timeout
- Use parameterized queries to prevent SQL injection
- Session cookies: secure, httpOnly, sameSite=Strict

## Known Pitfalls
- PostgreSQL connection pool must have connection limit set
- Email sending via Nodemailer can timeout on large batches—consider async queue
- CSV import parsing may fail on malformed data—add error recovery
- Session middleware order matters: before routes, after bodyParser

## Deployment
- Dev: Mac Studio (localhost:3000)
- Prod: Mac Mini via git pull + PM2 or systemd
- Use environment DATABASE_URL for PostgreSQL (default: localhost:5432/noco_crm)
- Never push directly to main

## References
@/Users/qbot/.openclaw/workspace/LESSONS-LEARNED.md
