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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wipko_attachments (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      file_size BIGINT NOT NULL DEFAULT 0,
      data BYTEA NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

app.get('/api/health', async (_req,res) => {
  try {
    const r = await pool.query('SELECT NOW() AS now');
    res.json({ ok:true, app:'WipkoERP Cloud v1', build:'persistence-fix-v3-attachments-v1', database:true, time:r.rows[0].now });
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

function recordKey(row, index) {
  if (!row || typeof row !== 'object') return `__index_${index}`;
  return String(row.id || row.invoiceNo || row.no || row.quotationNo || row.reference || row.code || row.username || `__index_${index}`);
}

function mergeArray(existing, incoming) {
  const out = [];
  const positions = new Map();
  (Array.isArray(existing) ? existing : []).forEach((row, i) => {
    const k = recordKey(row, i);
    positions.set(k, out.length);
    out.push(row);
  });
  (Array.isArray(incoming) ? incoming : []).forEach((row, i) => {
    const k = recordKey(row, i);
    if (positions.has(k)) {
      const pos = positions.get(k);
      const oldRow = out[pos];
      out[pos] = (oldRow && typeof oldRow === 'object' && row && typeof row === 'object')
        ? { ...oldRow, ...row }
        : row;
    } else {
      positions.set(k, out.length);
      out.push(row);
    }
  });
  return out;
}

function mergeDb(current, incoming) {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return incoming;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return current;
  const merged = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      merged[key] = mergeArray(current[key], value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = { ...(current[key] && typeof current[key] === 'object' ? current[key] : {}), ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

app.post('/api/db', async (req,res) => {
  const incoming=req.body && req.body.db;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return res.status(400).json({message:'Invalid ERP database payload'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const cur=await client.query('SELECT version, data FROM wipko_app_state WHERE id=1 FOR UPDATE');
    let nextVersion=1;
    let finalDb=incoming;
    let merged=false;
    if (cur.rowCount) {
      const currentVersion=Number(cur.rows[0].version||0);
      const supplied=Number(req.body.version||0);
      if (supplied!==currentVersion) {
        // Never reject a legitimate save just because another tab/PC saved first.
        // Merge by stable record identity so stale clients cannot erase newer cloud records.
        finalDb=mergeDb(cur.rows[0].data||{},incoming);
        merged=true;
      }
      nextVersion=currentVersion+1;
      await client.query('INSERT INTO wipko_state_backups(version,data,source) VALUES($1,$2::jsonb,$3)',[currentVersion,JSON.stringify(cur.rows[0].data),'pre-save']);
      await client.query('DELETE FROM wipko_state_backups WHERE id NOT IN (SELECT id FROM wipko_state_backups ORDER BY id DESC LIMIT 30)');
      await client.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[nextVersion,JSON.stringify(finalDb),String(req.body.source||incoming.__client||'web')]);
    } else {
      await client.query('INSERT INTO wipko_app_state(id,version,data,updated_by) VALUES(1,$1,$2::jsonb,$3)',[nextVersion,JSON.stringify(finalDb),String(req.body.source||'initial')]);
    }
    await client.query('COMMIT');
    res.json({ok:true,version:nextVersion,merged,db:finalDb});
  } catch(e) {
    try{await client.query('ROLLBACK')}catch(_e){}
    console.error('Database save failed:',e);
    res.status(500).json({message:'Database save failed',detail:e.message});
  } finally { client.release(); }
});


// Cloud attachment storage: keep binary files outside the ERP JSON snapshot.
app.post('/api/attachments', express.raw({type:'application/octet-stream',limit:'30mb'}), async (req,res) => {
  try {
    const data=Buffer.isBuffer(req.body)?req.body:Buffer.alloc(0);
    if(!data.length)return res.status(400).json({message:'Empty attachment'});
    const max=25*1024*1024;
    if(data.length>max)return res.status(413).json({message:'Attachment is too large. Maximum file size is 25 MB.'});
    const id='ATT-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,10).toUpperCase();
    const fileName=decodeURIComponent(String(req.headers['x-file-name']||'attachment')).slice(0,255);
    const mime=String(req.headers['x-file-type']||'application/octet-stream').slice(0,150);
    await pool.query('INSERT INTO wipko_attachments(id,file_name,mime_type,file_size,data) VALUES($1,$2,$3,$4,$5)',[id,fileName,mime,data.length,data]);
    res.json({ok:true,id,name:fileName,type:mime,size:data.length,url:'/api/attachments/'+encodeURIComponent(id)});
  } catch(e){console.error('Attachment upload failed:',e);res.status(500).json({message:'Attachment upload failed',detail:e.message});}
});

app.get('/api/attachments/:id', async (req,res) => {
  try {
    const r=await pool.query('SELECT file_name,mime_type,file_size,data FROM wipko_attachments WHERE id=$1',[String(req.params.id||'')]);
    if(!r.rowCount)return res.status(404).send('Attachment not found');
    const row=r.rows[0];
    res.setHeader('Content-Type',row.mime_type||'application/octet-stream');
    res.setHeader('Content-Length',String(row.file_size||row.data.length));
    res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(row.file_name||'attachment')}`);
    res.setHeader('Cache-Control','private, max-age=3600');
    res.send(row.data);
  } catch(e){console.error('Attachment read failed:',e);res.status(500).send('Attachment read failed');}
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
