const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required. Add ${{Postgres.DATABASE_URL}} in Railway.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false, limit: '50mb' }));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wipko_app_state (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      version BIGINT NOT NULL DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_by TEXT
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wipko_state_backups (
      id BIGSERIAL PRIMARY KEY,
      version BIGINT NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source TEXT
    )
  `);
}

app.get('/api/health', async (_req,res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now');
    res.json({ ok:true, app:'WipkoERP Cloud v1', database:true, time:r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok:false, database:false, message:e.message });
  }
});
app.get('/api/ping', (_req,res) => res.json({ok:true, mode:'railway-cloud'}));

app.get('/api/db', async (_req,res) => {
  try {
    const r = await pool.query('SELECT version, data, updated_at FROM wipko_app_state WHERE id=1');
    if (!r.rowCount) return res.json({ version:0, db:null, empty:true });
    res.json({ version:Number(r.rows[0].version), db:r.rows[0].data, updatedAt:r.rows[0].updated_at });
  } catch (e) {
    console.error(e);res.status(500).json({message:'Database read failed'});
  }
});

app.post('/api/db', async (req,res) => {
  const incoming=req.body && req.body.db;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({message:'Invalid ERP database payload'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const cur=await client.query('SELECT version, data FROM wipko_app_state WHERE id=1 FOR UPDATE');
    let nextVersion=1, conflict=false;
    if (cur.rowCount) {
      const currentVersion=Number(cur.rows[0].version||0);
      const supplied=Number(req.body.version||0);
      conflict=Boolean(supplied && supplied!==currentVersion);
      nextVersion=currentVersion+1;
      // Keep a rolling server-side snapshot before replacement.
      await client.query('INSERT INTO wipko_state_backups(version,data,source) VALUES($1,$2::jsonb,$3)',[currentVersion,JSON.stringify(cur.rows[0].data),'pre-save']);
      await client.query('DELETE FROM wipko_state_backups WHERE id NOT IN (SELECT id FROM wipko_state_backups ORDER BY id DESC LIMIT 30)');
      await client.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[nextVersion,JSON.stringify(incoming),String(req.body.source||incoming.__client||'web')]);
    } else {
      await client.query('INSERT INTO wipko_app_state(id,version,data,updated_by) VALUES(1,$1,$2::jsonb,$3)',[nextVersion,JSON.stringify(incoming),String(req.body.source||'initial')]);
    }
    await client.query('COMMIT');
    res.json({ok:true,version:nextVersion,conflict});
  } catch(e) {
    await client.query('ROLLBACK');console.error(e);res.status(500).json({message:'Database save failed'});
  } finally { client.release(); }
});

// Admin-friendly cloud backup download of the central state.
app.get('/api/backup', async (_req,res) => {
  try {
    const r=await pool.query('SELECT version,data FROM wipko_app_state WHERE id=1');
    if(!r.rowCount)return res.status(404).json({message:'No cloud data yet'});
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="WipkoERP_Cloud_Backup_${stamp}.json"`);
    res.send(JSON.stringify({application:'WipkoERP_Cloud_v1',version:Number(r.rows[0].version),createdAt:new Date().toISOString(),db:r.rows[0].data},null,2));
  } catch(e){res.status(500).json({message:'Backup failed'});}
});

app.use(express.static(path.join(__dirname,'public'), { maxAge: 0, etag: false }));
app.get('*', (_req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(() => app.listen(PORT,'0.0.0.0',() => console.log(`WipkoERP Cloud v1 listening on ${PORT}`))).catch(err => {
  console.error('Database initialization failed:',err);process.exit(1);
});
