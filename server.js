const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL is required. Add ${{Postgres.DATABASE_URL}} in Railway.'); process.exit(1); }
const pool = new Pool({connectionString:DATABASE_URL,ssl:DATABASE_URL.includes('localhost')?false:{rejectUnauthorized:false},max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:10000});
const SESSION_COOKIE='wipko_session',SESSION_TTL_SEC=Math.max(3600,Number(process.env.WIPKO_SESSION_TTL_SEC||604800)||604800);
const SESSION_SECRET=String(process.env.WIPKO_SESSION_SECRET||process.env.SESSION_SECRET||DATABASE_URL);
function b64url(v){return Buffer.from(v).toString('base64url')}
function sessionSign(raw){return crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('base64url')}
function sessionToken(user){const raw=b64url(JSON.stringify({id:String(user.id||''),username:String(user.username||''),exp:Math.floor(Date.now()/1000)+SESSION_TTL_SEC}));return raw+'.'+sessionSign(raw)}
function parseCookies(req){const out={};String(req.headers.cookie||'').split(';').forEach(part=>{const i=part.indexOf('=');if(i>0)out[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim())});return out}
function verifySession(req){try{const tok=parseCookies(req)[SESSION_COOKIE];if(!tok)return null;const i=tok.lastIndexOf('.');if(i<1)return null;const raw=tok.slice(0,i),sig=tok.slice(i+1),want=sessionSign(raw);const a=Buffer.from(sig),b=Buffer.from(want);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;const payload=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(!payload.exp||payload.exp<Math.floor(Date.now()/1000))return null;return payload}catch(_e){return null}}
function setSessionCookie(req,res,user){const secure=(String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https'||!!process.env.RAILWAY_ENVIRONMENT||process.env.NODE_ENV==='production');res.append('Set-Cookie',SESSION_COOKIE+'='+encodeURIComponent(sessionToken(user))+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+SESSION_TTL_SEC+(secure?'; Secure':''))}
function clearSessionCookie(req,res){const secure=(String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https'||!!process.env.RAILWAY_ENVIRONMENT||process.env.NODE_ENV==='production');res.append('Set-Cookie',SESSION_COOKIE+'=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(secure?'; Secure':''))}
const BACKUP_KEEP=Math.max(3,Math.min(50,Number(process.env.WIPKO_BACKUP_KEEP||10)||10));
app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:false}));app.use(compression());
const JSON_BODY_LIMIT=String(process.env.WIPKO_JSON_LIMIT||'200mb');
app.use((req,res,next)=>{if(req.method==='POST'&&req.path==='/api/db'){const started=Date.now(),declared=Number(req.headers['content-length']||0)||0;res.on('finish',()=>{console.log('[v040 /api/db save] status=%s declared=%sMB duration=%sms',res.statusCode,(declared/1048576).toFixed(2),Date.now()-started)});req._wipkoSaveStarted=started;req._wipkoDeclaredBytes=declared}next()});
app.use(express.json({limit:JSON_BODY_LIMIT}));app.use(express.urlencoded({extended:false,limit:JSON_BODY_LIMIT}));
async function syncAuthUsers(db,executor=pool){
 const users=Array.isArray(db&&db.users)?db.users:[],roleSettings=db&&db.roleSettings&&typeof db.roleSettings==='object'?db.roleSettings:{};
 await executor.query('DELETE FROM wipko_auth_users');
 for(const u of users){
  const username=String(u&&u.username||'').trim();if(!username)continue;
  const role=String(u.role||'User'),enabled=(role==='Super Admin'||roleSettings[role]!==false);
  await executor.query(`INSERT INTO wipko_auth_users(id,username_key,username,password,name,role,status,permissions,role_enabled,updated_at)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,NOW())`,[
   String(u.id||username),username.toLowerCase(),username,String(u.password||''),String(u.name||username),role,String(u.status||'Active'),JSON.stringify(u.permissions||{}),enabled
  ]);
 }
}
function dashboardSnapshot(db,version=0){
 const accounts=Array.isArray(db&&db.accounts)?db.accounts:[],invoices=Array.isArray(db&&db.invoices)?db.invoices:[],cctv=Array.isArray(db&&db.cctv)?db.cctv:[];
 const n=v=>Number(v||0)||0, paid=i=>String(i&&i.payStatus||i&&i.paymentStatus||i&&i.status||'').toLowerCase()==='paid';
 const today=new Date();today.setHours(0,0,0,0);let income=0,expense=0,pending=0,overdue=0,amcDue=0;
 for(const a of accounts){if(a&&a.type==='Income')income+=n(a.amount);else if(a&&a.type==='Expense')expense+=n(a.amount)}
 for(const i of invoices){if(paid(i))continue;pending++;const d=i&&i.dueDate?new Date(i.dueDate+'T00:00:00'):null;if(d&&!Number.isNaN(d.getTime())&&d<today)overdue++}
 for(const a of cctv){const raw=a&&(a.amcExpiry||a.endingDate||a.endDate);if(!raw)continue;const d=new Date(raw+'T00:00:00');if(Number.isNaN(d.getTime()))continue;const days=Math.ceil((d-today)/86400000);if(days<=60)amcDue++}
 return {version:Number(version||0),income,expense,profit:income-expense,pendingInvoices:pending,overdueInvoices:overdue,amcDueSoon:amcDue,clients:Array.isArray(db&&db.clients)?db.clients.length:0,invoices:invoices.length,ledger:accounts.length,employees:Array.isArray(db&&db.employees)?db.employees.length:0,updatedAt:new Date().toISOString()};
}
async function syncDashboard(db,version=0,executor=pool){
 const snap=dashboardSnapshot(db,version);await executor.query(`INSERT INTO wipko_dashboard_state(id,version,data,updated_at) VALUES(1,$1,$2::jsonb,NOW()) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,data=EXCLUDED.data,updated_at=NOW()`,[Number(version||0),JSON.stringify(snap)]);
}
async function syncFastState(db,version=0,executor=pool){await syncAuthUsers(db,executor);await syncDashboard(db,version,executor)}
async function initDb(){
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_app_state (id SMALLINT PRIMARY KEY CHECK (id=1),version BIGINT NOT NULL DEFAULT 1,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_state_backups (id BIGSERIAL PRIMARY KEY,version BIGINT NOT NULL,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),source TEXT)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_auth_users (id TEXT PRIMARY KEY,username_key TEXT UNIQUE NOT NULL,username TEXT NOT NULL,password TEXT NOT NULL,name TEXT,role TEXT,status TEXT,permissions JSONB NOT NULL DEFAULT '{}'::jsonb,role_enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS wipko_auth_users_username_idx ON wipko_auth_users(username_key)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_dashboard_state (id SMALLINT PRIMARY KEY CHECK(id=1),version BIGINT NOT NULL DEFAULT 0,data JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 const r=await pool.query('SELECT version,data FROM wipko_app_state WHERE id=1');if(r.rowCount)await syncFastState(r.rows[0].data||{},Number(r.rows[0].version||0));
}
app.get('/api/health',async(_q,res)=>{try{const r=await pool.query('SELECT NOW() AS now');res.json({ok:true,app:'WipkoERP Cloud v1',build:'session-indexed-cache-v040',database:true,time:r.rows[0].now})}catch(e){res.status(500).json({ok:false,database:false,message:e.message})}});app.get('/api/ping',(_q,res)=>res.json({ok:true,mode:'railway-cloud'}));
app.post('/api/login',async(req,res)=>{try{
 const username=String(req.body&&req.body.username||'').trim().toLowerCase(),password=String(req.body&&req.body.password||'');if(!username||!password)return res.status(400).json({ok:false,message:'Enter username and password'});
 const r=await pool.query('SELECT id,username,password,name,role,status,permissions,role_enabled FROM wipko_auth_users WHERE username_key=$1 LIMIT 1',[username]);
 if(!r.rowCount)return res.status(401).json({ok:false,message:'Invalid username or password'});const u=r.rows[0];
 if(String(u.password||'')!==password||String(u.status||'Active').toLowerCase()==='inactive')return res.status(401).json({ok:false,message:'Invalid username or password'});
 if(!u.role_enabled)return res.status(403).json({ok:false,message:'This user role is disabled by Super Admin'});
 setSessionCookie(req,res,u);res.set('Cache-Control','no-store');res.json({ok:true,user:{id:u.id,name:u.name||u.username,username:u.username,role:u.role||'User',permissions:u.permissions||{}}});
}catch(e){console.error('Login failed:',e);res.status(500).json({ok:false,message:'Login service unavailable'})}});
app.get('/api/session',async(req,res)=>{try{const sess=verifySession(req);if(!sess){clearSessionCookie(req,res);return res.status(401).json({ok:false})}const r=await pool.query('SELECT id,username,name,role,status,permissions,role_enabled FROM wipko_auth_users WHERE id=$1 OR username_key=$2 LIMIT 1',[String(sess.id||''),String(sess.username||'').toLowerCase()]);if(!r.rowCount){clearSessionCookie(req,res);return res.status(401).json({ok:false})}const u=r.rows[0];if(String(u.status||'Active').toLowerCase()==='inactive'||!u.role_enabled){clearSessionCookie(req,res);return res.status(401).json({ok:false})}setSessionCookie(req,res,u);res.set('Cache-Control','no-store');res.json({ok:true,user:{id:u.id,name:u.name||u.username,username:u.username,role:u.role||'User',permissions:u.permissions||{}}})}catch(e){console.error('Session check failed:',e);res.status(503).json({ok:false,message:'Session service unavailable'})}});
app.post('/api/logout',(req,res)=>{clearSessionCookie(req,res);res.set('Cache-Control','no-store');res.json({ok:true})});
app.get('/api/db-meta',async(_req,res)=>{try{const r=await pool.query('SELECT version,updated_at FROM wipko_app_state WHERE id=1');res.set('Cache-Control','no-store');if(!r.rowCount)return res.json({ok:true,version:0,empty:true});res.json({ok:true,version:Number(r.rows[0].version||0),updatedAt:r.rows[0].updated_at})}catch(e){console.error('DB meta failed:',e);res.status(500).json({ok:false,message:'Database metadata unavailable'})}});
app.get('/api/dashboard',async(_q,res)=>{try{const r=await pool.query('SELECT version,data,updated_at FROM wipko_dashboard_state WHERE id=1');if(!r.rowCount)return res.json({ok:true,version:0,data:{}});res.set('Cache-Control','no-store');res.json({ok:true,version:Number(r.rows[0].version||0),data:r.rows[0].data||{},updatedAt:r.rows[0].updated_at})}catch(e){console.error('Dashboard summary failed:',e);res.status(500).json({ok:false,message:'Dashboard summary unavailable'})}});
app.get('/api/db',async(req,res)=>{const started=Date.now();try{const meta=await pool.query('SELECT version,updated_at FROM wipko_app_state WHERE id=1');if(!meta.rowCount)return res.json({version:0,db:null,empty:true});const version=Number(meta.rows[0].version||0),etag='\"wipko-db-v'+version+'\"';res.set('ETag',etag);res.set('Cache-Control','private, max-age=0, must-revalidate');if(String(req.headers['if-none-match']||'')===etag){res.set('Server-Timing','db;dur='+(Date.now()-started));return res.status(304).end()}const r=await pool.query('SELECT data,pg_column_size(data) AS pg_bytes FROM wipko_app_state WHERE id=1');const body=JSON.stringify({version,db:r.rows[0].data,updatedAt:meta.rows[0].updated_at}),bytes=Buffer.byteLength(body);res.set('X-Wipko-DB-Bytes',String(bytes));res.set('X-Wipko-PG-Bytes',String(Number(r.rows[0].pg_bytes||0)));res.set('Server-Timing','db;dur='+(Date.now()-started));console.log('[v040 /api/db] version=%s json=%sMB pg=%sMB build=%sms',version,(bytes/1048576).toFixed(2),(Number(r.rows[0].pg_bytes||0)/1048576).toFixed(2),Date.now()-started);res.type('application/json').send(body)}catch(e){console.error(e);res.status(500).json({message:'Database read failed'})}});
app.get('/api/db-stats',async(_q,res)=>{try{const r=await pool.query('SELECT version,data,updated_at,pg_column_size(data) AS pg_bytes FROM wipko_app_state WHERE id=1');if(!r.rowCount)return res.json({ok:true,empty:true});const db=r.rows[0].data||{},collections={};for(const [k,v] of Object.entries(db)){if(Array.isArray(v)){let chars=0;try{chars=JSON.stringify(v).length}catch(_e){}collections[k]={rows:v.length,approxBytes:chars}}}const sorted=Object.entries(collections).sort((a,b)=>b[1].approxBytes-a[1].approxBytes);const jsonBytes=Buffer.byteLength(JSON.stringify(db));res.set('Cache-Control','no-store');res.json({ok:true,version:Number(r.rows[0].version||0),jsonBytes,pgBytes:Number(r.rows[0].pg_bytes||0),updatedAt:r.rows[0].updated_at,largestCollections:sorted.slice(0,15).map(([name,x])=>({name,rows:x.rows,approxBytes:x.approxBytes}))})}catch(e){console.error('DB stats failed:',e);res.status(500).json({ok:false,message:'DB stats unavailable'})}});
function key(row,i){if(!row||typeof row!=='object')return `__index_${i}`;if(row.col&&row.id)return `${row.col}|${row.id}`;return String(row.id||row.invoiceNo||row.no||row.quotationNo||row.reference||row.code||row.username||`__index_${i}`)}
function mapArr(a){const m=new Map();(Array.isArray(a)?a:[]).forEach((r,i)=>m.set(key(r,i),r));return m}
function cleanRow(r){if(!r||typeof r!=='object'||Array.isArray(r))return r;const x={...r};delete x._rev;delete x.updatedAt;delete x.updatedBy;return x}
function eq(a,b){return JSON.stringify(cleanRow(a))===JSON.stringify(cleanRow(b))}
function stamp(row,old,source){if(!row||typeof row!=='object'||Array.isArray(row))return row;const now=new Date().toISOString(),prev=Number(old&&old._rev||row._rev||0);return {...row,_rev:prev+1,createdAt:row.createdAt||(old&&old.createdAt)||now,createdBy:row.createdBy||(old&&old.createdBy)||source,updatedAt:now,updatedBy:source}}
function tombstones(db){const m=new Map();for(const t of(db&&Array.isArray(db._deleted)?db._deleted:[])){if(!t||!t.col||!t.id)continue;const k=`${t.col}|${t.id}`,o=m.get(k);if(!o||Number(t.at||0)>=Number(o.at||0))m.set(k,t)}return m}
function mergeSpecial(a,b){const out=[],seen=new Map();for(const r of [...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]){const k=key(r,out.length),p=seen.get(k);if(p===undefined){seen.set(k,out.length);out.push(r)}else{const old=out[p];out[p]=Number(r&&r.at||r&&r.deletedAt||0)>=Number(old&&old.at||old&&old.deletedAt||0)?r:old}}return out}
function unionStrings(a,b){const o=[],s=new Set();for(const v of[...(Array.isArray(a)?a:[]),...(Array.isArray(b)?b:[])]){const x=String(v==null?'':v).trim(),k=x.toLowerCase();if(x&&!s.has(k)){s.add(k);o.push(x)}}return o}
function prune(db){if(!db||typeof db!=='object')return db;const t=tombstones(db);for(const c of Object.keys(db)){if(!Array.isArray(db[c])||c==='_deleted'||c==='_recycleBin')continue;db[c]=db[c].filter(r=>!r||!r.id||!t.has(`${c}|${r.id}`))}return db}
function mergeRecordArray(base,current,incoming,col,source,conflicts){const bm=mapArr(base),cm=mapArr(current),im=mapArr(incoming),keys=new Set([...bm.keys(),...cm.keys(),...im.keys()]),out=[];for(const k of keys){const b=bm.get(k),c=cm.get(k),n=im.get(k);if(n===undefined){if(c!==undefined)out.push(c);continue}if(c===undefined){if(b===undefined)out.push(stamp(n,null,source));continue}if(b===undefined){if(eq(c,n))out.push(c);else{conflicts.push({collection:col,id:k});out.push(c)}continue}const nc=!eq(n,b),cc=!eq(c,b);if(!nc){out.push(c);continue}if(!cc){out.push(stamp(n,c,source));continue}if(eq(n,c)){out.push(c);continue}conflicts.push({collection:col,id:k});out.push(c)}return out}
function mergeDb(base,current,incoming,source){const merged={...current},conflicts=[];const keys=new Set([...Object.keys(current||{}),...Object.keys(incoming||{})]);for(const k of keys){const n=incoming&&incoming[k],c=current&&current[k],b=base&&base[k];if(k==='_deleted'||k==='_recycleBin'){merged[k]=mergeSpecial(c,n);continue}if(Array.isArray(n)||Array.isArray(c)){merged[k]=mergeRecordArray(b,c,n,k,source,conflicts);continue}if(n&&typeof n==='object'&&!Array.isArray(n)){merged[k]={...(c&&typeof c==='object'?c:{}),...n};if(k==='master'){merged[k].incomeCategory=unionStrings(c&&c.incomeCategory,n.incomeCategory);merged[k].expenseCategory=unionStrings(c&&c.expenseCategory,n.expenseCategory)}continue}if(n!==undefined)merged[k]=n}return{db:prune(merged),conflicts}}
function acceptCurrentVersion(current,incoming,source){const out={...incoming};for(const k of Object.keys(out)){if(k==='_deleted'||k==='_recycleBin')continue;if(!Array.isArray(out[k]))continue;const cm=mapArr(current&&current[k]);out[k]=out[k].map((r,i)=>{const old=cm.get(key(r,i));return !old||!eq(old,r)?stamp(r,old,source):old})}out._deleted=mergeSpecial(current&&current._deleted,incoming&&incoming._deleted);out._recycleBin=mergeSpecial(current&&current._recycleBin,incoming&&incoming._recycleBin);return prune(out)}
app.post('/api/db',async(req,res)=>{
 const incoming=req.body&&req.body.db;
 if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({message:'Invalid ERP database payload'});
 const source=String(req.body.source||incoming.__client||'web'),suppliedVersion=Number(req.body.version||0),client=await pool.connect();
 const started=Date.now();
 try{
  await client.query('BEGIN');
  const finalDb=prune(incoming),json=JSON.stringify(finalDb);
  let next=1,write;
  if(suppliedVersion>0){
   // v039: normal saves are one atomic record update. Do not read/copy the full
   // previous JSON and do not create another 100+ MB snapshot for every click.
   write=await client.query(`UPDATE wipko_app_state
     SET version=version+1,data=$1::jsonb,updated_at=NOW(),updated_by=$2
     WHERE id=1 AND version=$3 RETURNING version`,[json,source,suppliedVersion]);
   if(!write.rowCount){
    const meta=await client.query('SELECT version FROM wipko_app_state WHERE id=1');
    await client.query('ROLLBACK');
    return res.status(409).json({ok:false,conflict:true,currentVersion:meta.rowCount?Number(meta.rows[0].version||0):0,message:'Cloud data changed on another PC. Reload the latest cloud data before saving again.'});
   }
   next=Number(write.rows[0].version||suppliedVersion+1);
  }else{
   write=await client.query(`INSERT INTO wipko_app_state(id,version,data,updated_by)
     VALUES(1,1,$1::jsonb,$2) ON CONFLICT(id) DO NOTHING RETURNING version`,[json,source]);
   if(!write.rowCount){
    const meta=await client.query('SELECT version FROM wipko_app_state WHERE id=1');
    await client.query('ROLLBACK');
    return res.status(409).json({ok:false,conflict:true,currentVersion:meta.rowCount?Number(meta.rows[0].version||0):0,message:'Cloud database already exists. Reload the latest cloud data before saving.'});
   }
   next=Number(write.rows[0].version||1);
  }
  await syncFastState(finalDb,next,client);
  await client.query('COMMIT');
  console.log('[v040 /api/db direct save] version=%s payload=%sMB duration=%sms',next,(Buffer.byteLength(json)/1048576).toFixed(2),Date.now()-started);
  res.json({ok:true,version:next,merged:false,conflict:false,conflicts:[]});
 }catch(e){
  try{await client.query('ROLLBACK')}catch(_e){}
  console.error('Database save failed:',e);
  res.status(500).json({message:'Database save failed',detail:e.message});
 }finally{client.release()}
});
app.post('/api/reset-business',async(req,res)=>{const incoming=req.body&&req.body.db;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({message:'Invalid reset database payload'});const source=String(req.body.source||'WipkoERP_v28_complete_reset'),client=await pool.connect();try{await client.query('BEGIN');const cur=await client.query('SELECT version,data FROM wipko_app_state WHERE id=1 FOR UPDATE');let next=1;if(cur.rowCount){const cv=Number(cur.rows[0].version||0),current=cur.rows[0].data||{};next=cv+1;await client.query('INSERT INTO wipko_state_backups(version,data,source) VALUES($1,$2::jsonb,$3)',[cv,JSON.stringify(current),'pre-complete-reset']);await client.query('DELETE FROM wipko_state_backups WHERE id NOT IN (SELECT id FROM wipko_state_backups ORDER BY id DESC LIMIT '+BACKUP_KEEP+')');await client.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[next,JSON.stringify(incoming),source])}else{await client.query('INSERT INTO wipko_app_state(id,version,data,updated_by) VALUES(1,$1,$2::jsonb,$3)',[next,JSON.stringify(incoming),source])}await syncFastState(incoming,next,client);await client.query('COMMIT');res.json({ok:true,reset:true,version:next,db:incoming})}catch(e){try{await client.query('ROLLBACK')}catch(_e){}console.error('Business reset failed:',e);res.status(500).json({message:'Business reset failed',detail:e.message})}finally{client.release()}});
app.get('/api/backup',async(_q,res)=>{try{const r=await pool.query('SELECT version,data FROM wipko_app_state WHERE id=1');if(!r.rowCount)return res.status(404).json({message:'No cloud data yet'});const stamp=new Date().toISOString().replace(/[:.]/g,'-');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="WipkoERP_Cloud_Backup_${stamp}.json"`);res.send(JSON.stringify({application:'WipkoERP_Cloud_v1',version:Number(r.rows[0].version),createdAt:new Date().toISOString(),db:r.rows[0].data},null,2))}catch(e){res.status(500).json({message:'Backup failed'})}});
app.use((req,res,next)=>{if(req.path==='/'||req.path.endsWith('/index.html')){res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.set('Pragma','no-cache');res.set('Expires','0');res.set('Surrogate-Control','no-store')}next()});app.use(express.static(path.join(__dirname,'public'),{maxAge:'7d',etag:true,setHeaders:(res,filePath)=>{if(/(?:^|[\\/])index\.html$/i.test(filePath)){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');return}if(/diagram-(maker\.(?:js|css|html)|header\.png|footer\.png|watermark-logo\.svg)$/i.test(filePath))res.setHeader('Cache-Control','public, max-age=604800')}}));app.get('*',(_q,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.sendFile(path.join(__dirname,'public','index.html'))});
let dbInitReady=false,dbInitTimer=null,dbInitAttempt=0;
async function initDbResilient(){clearTimeout(dbInitTimer);try{await initDb();dbInitReady=true;dbInitAttempt=0;console.log('WipkoERP database ready')}catch(err){dbInitReady=false;dbInitAttempt++;const wait=Math.min(15000,Math.max(3000,dbInitAttempt*3000));console.error('Database initialization unavailable; retrying in '+wait+'ms:',err&&err.message?err.message:err);dbInitTimer=setTimeout(initDbResilient,wait)}}
const httpServer=app.listen(PORT,'0.0.0.0',()=>{console.log(`WipkoERP Cloud v040 listening on ${PORT}; JSON body limit ${JSON_BODY_LIMIT}`);initDbResilient()});
httpServer.requestTimeout=10*60*1000;
httpServer.headersTimeout=65*1000;
