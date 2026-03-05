# NoCo AI CRM

CRM for DJ Bonifacic's NoCo AI consulting outreach.

## Stack
- Node.js + Express (no native modules — uses built-in `node:sqlite`)
- Vanilla JS/HTML/CSS frontend
- SQLite via `node:sqlite` (Node 22.5+)

## Run locally
```bash
npm install
node server.js
# → http://localhost:3000
# Login: dj / wolfpack2026
```

## Deploy
Deployed on Render. Node >= 22.5 required.

## Features
- Lead management (2200+ NoCo businesses)
- Status tracking (Pursue/Maybe/Hide/Untouched)
- Email template editor with merge fields
- Bulk email sending (max 20/hr, rate-limited)
- CSV export
- Email send logs
