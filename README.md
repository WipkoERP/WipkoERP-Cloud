# WipkoERP Cloud v1 — Railway

Railway-ready cloud branch of WipkoERP.

## Railway services
- WipkoERP-App (this repository)
- Postgres

## Required variable
`DATABASE_URL=${{Postgres.DATABASE_URL}}`

## Deploy
1. Upload all files in this repository to GitHub.
2. Connect the GitHub repo to Railway service `WipkoERP-App`.
3. Railway detects Node.js from `package.json`.
4. Deploy.
5. Generate a public domain under Railway Networking.

## First login
Default: `admin / admin123` until you change it in User Management.

## Persistence
The central ERP state is stored in Railway PostgreSQL. Browser local storage is only a cache. There is no Google Drive or LAN synchronization.

## Backup
The existing ERP backup UI remains available. The server also exposes `/api/backup` for a central JSON snapshot. Server keeps up to 30 pre-save snapshots in PostgreSQL.

## Cloud v1 concurrency note
Cloud v1 preserves the existing ERP data model as one authoritative PostgreSQL JSON state to minimize changes to confirmed workflows. It is safe for access from different PCs, especially when one person edits at a time. A later normalized multi-user database edition can add row-level concurrent editing without changing the UI.
