# WipkoERP Cloud v044 — GitHub + GoDaddy

This package is the current WipkoERP v044 application adapted to run **completely on GoDaddy Node.js Hosting + GoDaddy Managed MySQL**. Railway/PostgreSQL is not required after migration.

## Final hosting layout

- **GitHub** — source-code repository and version history
- **GoDaddy Node.js Hosting** — WipkoERP application
- **GoDaddy Managed MySQL** — ERP database, users, live-sync state, media and Diagram Maker data
- **erp.wipko.com** — production domain on GoDaddy

The existing WipkoERP UI, Client/Ledger/AMC workflows, Invoice/Quotation/Proforma output, AMC contract, seal/signature positions and Diagram Maker behavior are preserved.

## What changed for GoDaddy

- PostgreSQL driver replaced by `mysql2`.
- The app reads GoDaddy's managed database variables: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.
- Database tables are created automatically on first successful start.
- Existing v044 live multi-PC sync (SSE), record-level `/api/sync`, separated media and Diagram Maker storage remain enabled.
- No Railway `DATABASE_URL` is needed.

## First migration

1. While Railway v044 is still online, download one **full WipkoERP Cloud Backup JSON** from the ERP Backup function (`/api/backup`). This backup includes core ERP data, separated media and diagrams.
2. Push this folder to a private GitHub repository.
3. In GoDaddy Node.js Hosting choose **Connect GitHub**, select the repository and branch, then deploy.
4. Enable/publish with the GoDaddy managed MySQL database. GoDaddy provides the `DB_*` variables automatically.
5. Add one temporary GoDaddy secret: `WIPKO_BOOTSTRAP_PASSWORD` with a password you choose. Optional username secret: `WIPKO_BOOTSTRAP_USER` (defaults to `admin`).
6. Restart the GoDaddy app. Login with the temporary admin account.
7. In WipkoERP use **Restore Data File** and select the full Railway v044 backup JSON.
8. Logout, then login using your normal WipkoERP user from the restored database.
9. Remove the temporary `WIPKO_BOOTSTRAP_PASSWORD` secret and restart.
10. Verify `/api/health` and `/api/db-stats`, then test Clients, Ledger, invoices, AMC, media, Diagram Maker, backup/restore and live two-PC synchronization.
11. Keep Railway untouched until the GoDaddy production copy has been verified. Cancel Railway only after the new system is confirmed.

## GoDaddy secrets

GoDaddy injects the managed MySQL `DB_*` variables. Do not commit them to GitHub.

Recommended additional secret:

- `WIPKO_SESSION_SECRET` — a long random value. If omitted, WipkoERP derives a stable internal secret from the managed MySQL credentials.

Temporary migration secret:

- `WIPKO_BOOTSTRAP_PASSWORD` — remove after restoring the real backup.

## Health check

After deployment:

`/api/health`

Expected result includes:

```json
{"ok":true,"database":true,"configured":true}
```

## GitHub safety

Keep the GitHub repository **private** because this is proprietary ERP source code. `.env`, backups and `node_modules` are excluded by `.gitignore`.

See `GODADDY_SETUP.txt` and `MIGRATION_FROM_RAILWAY.txt` for the short deployment checklist.
