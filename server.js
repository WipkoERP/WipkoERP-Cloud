const express = require('express');
const compression = require('compression');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const { Pool, resolveMysqlConfig } = require('./mysql-pg-adapter');
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MYSQL_CONFIG=resolveMysqlConfig();
function mysqlConfigured(){return !!MYSQL_CONFIG}
const DATABASE_URL = mysqlConfigured() ? 'godaddy-mysql' : '';
const pool = mysqlConfigured() ? new Pool() : null;
if(!pool){
  console.error('[WipkoERP v044] GoDaddy managed MySQL is not configured. Publish the app with the GoDaddy database enabled so DB_HOST, DB_PORT, DB_NAME, DB_USER and DB_PASSWORD are available.');
}
const SESSION_COOKIE='wipko_session',SESSION_TTL_SEC=Math.max(3600,Number(process.env.WIPKO_SESSION_TTL_SEC||604800)||604800);
const DB_DERIVED_SECRET=MYSQL_CONFIG?crypto.createHash('sha256').update([MYSQL_CONFIG.host,MYSQL_CONFIG.port,MYSQL_CONFIG.user,MYSQL_CONFIG.password,MYSQL_CONFIG.database].join('|')).digest('hex'):'';
const SESSION_SECRET=String(process.env.WIPKO_SESSION_SECRET||process.env.SESSION_SECRET||DB_DERIVED_SECRET||'wipkoerp-v044-unconfigured');
function b64url(v){return Buffer.from(v).toString('base64url')}
function sessionSign(raw){return crypto.createHmac('sha256',SESSION_SECRET).update(raw).digest('base64url')}
function sessionToken(user){const raw=b64url(JSON.stringify({id:String(user.id||''),username:String(user.username||''),exp:Math.floor(Date.now()/1000)+SESSION_TTL_SEC}));return raw+'.'+sessionSign(raw)}
function parseCookies(req){const out={};String(req.headers.cookie||'').split(';').forEach(part=>{const i=part.indexOf('=');if(i>0)out[decodeURIComponent(part.slice(0,i).trim())]=decodeURIComponent(part.slice(i+1).trim())});return out}
function verifySession(req){try{const tok=parseCookies(req)[SESSION_COOKIE];if(!tok)return null;const i=tok.lastIndexOf('.');if(i<1)return null;const raw=tok.slice(0,i),sig=tok.slice(i+1),want=sessionSign(raw);const a=Buffer.from(sig),b=Buffer.from(want);if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return null;const payload=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));if(!payload.exp||payload.exp<Math.floor(Date.now()/1000))return null;return payload}catch(_e){return null}}
function setSessionCookie(req,res,user){const secure=(String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https'||process.env.NODE_ENV==='production');res.append('Set-Cookie',SESSION_COOKIE+'='+encodeURIComponent(sessionToken(user))+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+SESSION_TTL_SEC+(secure?'; Secure':''))}
function clearSessionCookie(req,res){const secure=(String(req.headers['x-forwarded-proto']||'').toLowerCase()==='https'||process.env.NODE_ENV==='production');res.append('Set-Cookie',SESSION_COOKIE+'=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(secure?'; Secure':''))}
const BACKUP_KEEP=Math.max(3,Math.min(50,Number(process.env.WIPKO_BACKUP_KEEP||10)||10));
const liveClients=new Set();
function liveBroadcast(event,payload){
 const data='event: '+event+'\n'+'data: '+JSON.stringify(payload||{})+'\n\n';
 for(const res of [...liveClients]){try{res.write(data)}catch(_e){liveClients.delete(res)}}
}
function isDataUri(v){return typeof v==='string'&&/^data:[^;,]+(?:;[^,]*)?,/i.test(v)}
function mediaRef(id){return id?'media:'+id:''}
function mediaRefId(v){return typeof v==='string'&&v.startsWith('media:')?v.slice(6):''}
function mediaKey(ownerType,ownerId,field){return [ownerType,ownerId,field].map(v=>String(v||'').replace(/[^a-zA-Z0-9_.:-]/g,'_')).join(':')}
async function putMedia(executor,ownerType,ownerId,field,data){
 if(data==null||data==='')return '';
 const id=mediaKey(ownerType,ownerId,field),txt=typeof data==='string'?data:JSON.stringify(data),mime=isDataUri(txt)?String(txt.slice(5,txt.indexOf(';')>0?txt.indexOf(';'):txt.indexOf(','))||'application/octet-stream'):'application/json';
 await executor.query(`INSERT INTO wipko_media(id,owner_type,owner_id,field_name,mime_type,data,updated_at)
 VALUES($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT(id) DO UPDATE SET mime_type=EXCLUDED.mime_type,data=EXCLUDED.data,updated_at=NOW()`,[id,String(ownerType),String(ownerId),String(field),mime,txt]);
 return mediaRef(id)
}
async function putDiagram(executor,clientId,d){
 if(!d||typeof d!=='object')return null;const id=String(d.id||('DGM-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7))),name=String(d.name||'CCTV Diagram'),data=d.data&&typeof d.data==='object'?d.data:{};
 await executor.query(`INSERT INTO wipko_diagrams(id,client_id,name,data,saved_at,updated_at) VALUES($1,$2,$3,$4::jsonb,COALESCE($5::timestamptz,NOW()),COALESCE($6::timestamptz,NOW()))
 ON CONFLICT(id) DO UPDATE SET client_id=EXCLUDED.client_id,name=EXCLUDED.name,data=EXCLUDED.data,updated_at=NOW()`,[id,String(clientId||''),name,JSON.stringify(data),d.savedAt||null,d.updatedAt||null]);
 return id
}
app.disable('x-powered-by');app.use(helmet({contentSecurityPolicy:false,crossOriginResourcePolicy:false}));app.use(compression());
const JSON_BODY_LIMIT=String(process.env.WIPKO_JSON_LIMIT||'200mb');
app.use((req,res,next)=>{if(req.method==='POST'&&req.path==='/api/db'){const started=Date.now(),declared=Number(req.headers['content-length']||0)||0;res.on('finish',()=>{console.log('[v044 /api/db save] status=%s declared=%sMB duration=%sms',res.statusCode,(declared/1048576).toFixed(2),Date.now()-started)});req._wipkoSaveStarted=started;req._wipkoDeclaredBytes=declared}next()});
app.use(express.json({limit:JSON_BODY_LIMIT}));app.use(express.urlencoded({extended:false,limit:JSON_BODY_LIMIT}));
app.use((req,res,next)=>{
  if(pool||req.path==='/api/health'||req.path==='/api/ping')return next();
  if(req.path.startsWith('/api/')){
    res.set('Cache-Control','no-store');
    return res.status(503).json({ok:false,database:false,configured:false,message:'GoDaddy MySQL is not configured. Enable the managed database for this Node.js app and restart it.'});
  }
  next();
});
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
async function sanitizeRecordForCloud(col,row,executor){
 if(!row||typeof row!=='object'||Array.isArray(row))return row;
 const x={...row},id=String(x.id||x.username||'');
 if(col==='clients'){
   delete x.logo;delete x.clientLogo;
   if(Array.isArray(x.diagrams)){for(const d of x.diagrams)await putDiagram(executor,id,d);delete x.diagrams}
   delete x.diagramFile;
   for(const k of ['signature','seal','documents','attachments','files']){
     const v=x[k];if(v&&(isDataUri(v)||(typeof v==='string'&&v.length>100000)||typeof v==='object')){await putMedia(executor,'client',id,k,v);delete x[k]}
   }
 }
 if(col==='users'){
   let photo=x.photo||x.profilePic||x.profilePhoto||x.avatar||'';
   if(photo&&mediaRefId(photo)===''){x.photo=await putMedia(executor,'user',id,'photo',photo)}else if(photo)x.photo=photo;
   delete x.avatar;delete x.profilePic;delete x.profilePhoto;
   if(x.signature&&mediaRefId(x.signature)==='')x.signature=await putMedia(executor,'user',id,'signature',x.signature);
 }
 if(col==='cctv'){
   for(const k of ['clientSign','clientSeal','screens']){
     const v=x[k];if(v&&mediaRefId(v)==='')x[k]=await putMedia(executor,'cctv',id,k,v)
   }
   delete x.contract;delete x.diagram;delete x.pdf;delete x.pdfData;delete x.contractPdf;delete x.diagramFile;
 }
 return x
}
async function sanitizeWholeDb(db,executor){
 const out={...(db||{})};
 for(const col of ['clients','users','cctv']){
   const arr=Array.isArray(out[col])?out[col]:[];const next=[];for(const r of arr)next.push(await sanitizeRecordForCloud(col,r,executor));out[col]=next
 }
 return out
}
async function migrateHeavyState(){
 const c=await pool.connect();try{await c.query('BEGIN');const r=await c.query('SELECT version,data FROM wipko_app_state WHERE id=1 FOR UPDATE');if(!r.rowCount){await c.query('COMMIT');return}
   const before=r.rows[0].data||{},clean=await sanitizeWholeDb(before,c),a=JSON.stringify(before),b=JSON.stringify(clean);if(a!==b){const next=Number(r.rows[0].version||0)+1;await c.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[next,b,'v043-heavy-data-migration']);await syncFastState(clean,next,c);console.log('[v043 migration] stripped core ERP from %sMB to %sMB',(Buffer.byteLength(a)/1048576).toFixed(2),(Buffer.byteLength(b)/1048576).toFixed(2))}
   await c.query('COMMIT')
 }catch(e){try{await c.query('ROLLBACK')}catch(_e){}console.error('v043 heavy-state migration failed:',e);throw e}finally{c.release()}
}
async function bootstrapEmptyDatabase(){
 // Recovery/bootstrap mode for a fresh GoDaddy MySQL database.
 // If WIPKO_BOOTSTRAP_PASSWORD is present, always make sure the bootstrap
 // username can log in even when an earlier empty/default state already
 // populated wipko_auth_users. Remove the secret after restoring production data.
 const password=String(process.env.WIPKO_BOOTSTRAP_PASSWORD||'').trim();
 const username=String(process.env.WIPKO_BOOTSTRAP_USER||'admin').trim()||'admin';
 const usernameKey=username.toLowerCase();
 const auth=await pool.query('SELECT COUNT(*) AS count FROM wipko_auth_users');
 const authCount=Number(auth.rows&&auth.rows[0]&&auth.rows[0].count||0);

 if(!password){
   if(authCount>0)return false;
   console.warn('[WipkoERP v044] No login user exists yet. Set temporary WIPKO_BOOTSTRAP_PASSWORD, restart, login as admin, then restore the Railway backup.');
   return false;
 }

 const now=new Date().toISOString();
 const state=await pool.query('SELECT version,data FROM wipko_app_state WHERE id=1');
 let version=1;
 let db;
 if(state.rowCount){
   version=Number(state.rows[0].version||1);
   db=state.rows[0].data||{};
 }else{
   db={roleSettings:{},clients:[],accounts:[],invoices:[],quotations:[],proformas:[],cctv:[],employees:[],suppliers:[],vendors:[],companyVehicles:[],companyDocuments:[],reports:[],logs:[],importHistory:[],_deleted:[]};
 }

 const users=Array.isArray(db.users)?db.users:[];
 let bootstrapUser=users.find(u=>String(u&&u.username||'').trim().toLowerCase()===usernameKey);
 if(bootstrapUser){
   bootstrapUser.password=password;
   bootstrapUser.status='Active';
   bootstrapUser.updatedAt=now;
 }else{
   bootstrapUser={id:'USR-BOOTSTRAP',username,password,name:'Wipko Administrator',role:'Super Admin',status:'Active',permissions:{},createdAt:now,updatedAt:now};
   users.push(bootstrapUser);
 }
 db.users=users;

 if(state.rowCount){
   version+=1;
   await pool.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[version,JSON.stringify(db),'godaddy-bootstrap-login']);
 }else{
   await pool.query('INSERT INTO wipko_app_state(id,version,data,updated_by) VALUES(1,$1,$2::jsonb,$3)',[version,JSON.stringify(db),'godaddy-bootstrap-login']);
 }

 await syncFastState(db,version,pool);
 const verify=await pool.query('SELECT username,password,status FROM wipko_auth_users WHERE username_key=$1 LIMIT 1',[usernameKey]);
 if(!verify.rowCount||String(verify.rows[0].password||'')!==password){
   throw new Error('Bootstrap login verification failed');
 }
 console.log('[WipkoERP v044] GoDaddy bootstrap login ready for username: '+username+'. Restore the v044 backup, then remove WIPKO_BOOTSTRAP_PASSWORD.');
 return true;
}

async function initDb(){
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_app_state (id SMALLINT PRIMARY KEY CHECK (id=1),version BIGINT NOT NULL DEFAULT 1,data JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_by TEXT)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_state_backups (id BIGSERIAL PRIMARY KEY,version BIGINT NOT NULL,data JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),source TEXT)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_auth_users (id TEXT PRIMARY KEY,username_key TEXT UNIQUE NOT NULL,username TEXT NOT NULL,password TEXT NOT NULL,name TEXT,role TEXT,status TEXT,permissions JSONB NOT NULL DEFAULT '{}'::jsonb,role_enabled BOOLEAN NOT NULL DEFAULT TRUE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS wipko_auth_users_username_idx ON wipko_auth_users(username_key)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_dashboard_state (id SMALLINT PRIMARY KEY CHECK(id=1),version BIGINT NOT NULL DEFAULT 0,data JSONB NOT NULL DEFAULT '{}'::jsonb,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_media (id TEXT PRIMARY KEY,owner_type TEXT NOT NULL,owner_id TEXT NOT NULL,field_name TEXT NOT NULL,mime_type TEXT,data TEXT NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS wipko_media_owner_idx ON wipko_media(owner_type,owner_id)`);
 await pool.query(`CREATE TABLE IF NOT EXISTS wipko_diagrams (id TEXT PRIMARY KEY,client_id TEXT NOT NULL,name TEXT NOT NULL,data JSONB NOT NULL DEFAULT '{}'::jsonb,saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
 await pool.query(`CREATE INDEX IF NOT EXISTS wipko_diagrams_client_idx ON wipko_diagrams(client_id,updated_at DESC)`);
 await bootstrapEmptyDatabase();
 await migrateHeavyState();
 const r=await pool.query('SELECT version,data FROM wipko_app_state WHERE id=1');if(r.rowCount)await syncFastState(r.rows[0].data||{},Number(r.rows[0].version||0));
}
app.get('/api/health',async(_q,res)=>{if(!pool)return res.status(200).json({ok:true,app:'WipkoERP Cloud v1',build:'live-sync-v044-godaddy-mysql',database:false,configured:false,message:'GoDaddy managed MySQL is not configured'});try{const r=await pool.query('SELECT NOW() AS now');res.json({ok:true,app:'WipkoERP Cloud v1',build:'live-sync-v044-godaddy-mysql',database:true,configured:true,time:r.rows[0].now})}catch(e){res.status(200).json({ok:true,app:'WipkoERP Cloud v1',build:'live-sync-v044-godaddy-mysql',database:false,configured:true,message:e.message})}});app.get('/api/ping',(_q,res)=>res.json({ok:true,mode:'cloud',databaseConfigured:!!pool}));
app.post('/api/login',async(req,res)=>{try{
 const username=String(req.body&&req.body.username||'').trim().toLowerCase(),password=String(req.body&&req.body.password||'');if(!username||!password)return res.status(400).json({ok:false,message:'Enter username and password'});
 const bootstrapUser=String(process.env.WIPKO_BOOTSTRAP_USER||'admin').trim().toLowerCase()||'admin';
 const bootstrapPassword=String(process.env.WIPKO_BOOTSTRAP_PASSWORD||'').trim();
 let r=await pool.query('SELECT id,username,password,name,role,status,permissions,role_enabled FROM wipko_auth_users WHERE username_key=$1 LIMIT 1',[username]);
 // Fresh GoDaddy databases can receive an old pre-login /api/db save from the
 // browser before the first sign-in. If that happened, re-seed the temporary
 // bootstrap account directly from the GoDaddy secret and retry the lookup.
 if(bootstrapPassword&&username===bootstrapUser&&password===bootstrapPassword&&(!r.rowCount||String(r.rows[0].password||'')!==bootstrapPassword)){
   await bootstrapEmptyDatabase();
   r=await pool.query('SELECT id,username,password,name,role,status,permissions,role_enabled FROM wipko_auth_users WHERE username_key=$1 LIMIT 1',[username]);
   console.log('[WipkoERP v044] Bootstrap credentials refreshed during login.');
 }
 if(!r.rowCount)return res.status(401).json({ok:false,message:'Invalid username or password'});const u=r.rows[0];
 if(String(u.password||'')!==password||String(u.status||'Active').toLowerCase()==='inactive')return res.status(401).json({ok:false,message:'Invalid username or password'});
 if(!u.role_enabled)return res.status(403).json({ok:false,message:'This user role is disabled by Super Admin'});
 setSessionCookie(req,res,u);res.set('Cache-Control','no-store');res.json({ok:true,user:{id:u.id,name:u.name||u.username,username:u.username,role:u.role||'User',permissions:u.permissions||{}}});
}catch(e){console.error('Login failed:',e);res.status(500).json({ok:false,message:'Login service unavailable'})}});
app.get('/api/session',async(req,res)=>{try{const sess=verifySession(req);if(!sess){clearSessionCookie(req,res);return res.status(401).json({ok:false})}const r=await pool.query('SELECT id,username,name,role,status,permissions,role_enabled FROM wipko_auth_users WHERE id=$1 OR username_key=$2 LIMIT 1',[String(sess.id||''),String(sess.username||'').toLowerCase()]);if(!r.rowCount){clearSessionCookie(req,res);return res.status(401).json({ok:false})}const u=r.rows[0];if(String(u.status||'Active').toLowerCase()==='inactive'||!u.role_enabled){clearSessionCookie(req,res);return res.status(401).json({ok:false})}setSessionCookie(req,res,u);res.set('Cache-Control','no-store');res.json({ok:true,user:{id:u.id,name:u.name||u.username,username:u.username,role:u.role||'User',permissions:u.permissions||{}}})}catch(e){console.error('Session check failed:',e);res.status(503).json({ok:false,message:'Session service unavailable'})}});
app.post('/api/logout',(req,res)=>{clearSessionCookie(req,res);res.set('Cache-Control','no-store');res.json({ok:true})});
app.get('/api/events',(req,res)=>{if(!verifySession(req))return res.status(401).end();res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive'});res.flushHeaders&&res.flushHeaders();liveClients.add(res);res.write('event: ready\ndata: {"ok":true}\n\n');const hb=setInterval(()=>{try{res.write(': keepalive\n\n')}catch(_e){}},25000);req.on('close',()=>{clearInterval(hb);liveClients.delete(res)})});
app.get('/api/media/:ownerType/:ownerId/:field',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({ok:false});const id=mediaKey(req.params.ownerType,req.params.ownerId,req.params.field),r=await pool.query('SELECT id,mime_type,data,updated_at FROM wipko_media WHERE id=$1',[id]);res.set('Cache-Control','private, max-age=300');if(!r.rowCount)return res.status(404).json({ok:false});res.json({ok:true,id:r.rows[0].id,mimeType:r.rows[0].mime_type,data:r.rows[0].data,updatedAt:r.rows[0].updated_at})}catch(e){res.status(500).json({ok:false,message:'Media unavailable'})}});
app.put('/api/media/:ownerType/:ownerId/:field',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({ok:false});const ref=await putMedia(pool,req.params.ownerType,req.params.ownerId,req.params.field,req.body&&req.body.data);res.json({ok:true,ref})}catch(e){res.status(500).json({ok:false,message:'Media save failed',detail:e.message})}});
app.get('/api/diagrams',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({ok:false});const cid=String(req.query.clientId||'');const r=await pool.query('SELECT id,client_id,name,saved_at,updated_at FROM wipko_diagrams WHERE client_id=$1 ORDER BY updated_at DESC',[cid]);res.set('Cache-Control','no-store');res.json({ok:true,items:r.rows.map(x=>({id:x.id,clientId:x.client_id,name:x.name,savedAt:x.saved_at,updatedAt:x.updated_at}))})}catch(e){res.status(500).json({ok:false,message:'Diagram list unavailable'})}});
app.get('/api/diagram-meta',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({ok:false});const r=await pool.query(`SELECT DISTINCT ON (client_id) client_id,id,name,saved_at,updated_at FROM wipko_diagrams ORDER BY client_id,updated_at DESC`);res.set('Cache-Control','no-store');res.json({ok:true,items:r.rows.map(x=>({id:x.id,clientId:x.client_id,name:x.name,savedAt:x.saved_at,updatedAt:x.updated_at}))})}catch(e){res.status(500).json({ok:false,message:'Diagram metadata unavailable'})}});
app.get('/api/diagrams/:id',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({ok:false});const r=await pool.query('SELECT id,client_id,name,data,saved_at,updated_at FROM wipko_diagrams WHERE id=$1',[String(req.params.id)]);if(!r.rowCount)return res.status(404).json({ok:false});const x=r.rows[0];res.set('Cache-Control','no-store');res.json({ok:true,id:x.id,clientId:x.client_id,name:x.name,data:x.data,savedAt:x.saved_at,updatedAt:x.updated_at})}catch(e){res.status(500).json({ok:false,message:'Diagram unavailable'})}});
app.put('/api/diagrams/:id',async(req,res)=>{try{const sess=verifySession(req);if(!sess)return res.status(401).json({ok:false});const id=String(req.params.id),cid=String(req.body&&req.body.clientId||''),name=String(req.body&&req.body.name||'CCTV Diagram'),data=req.body&&req.body.data;if(!cid||!data||typeof data!=='object')return res.status(400).json({ok:false,message:'Invalid diagram'});await pool.query(`INSERT INTO wipko_diagrams(id,client_id,name,data,saved_at,updated_at) VALUES($1,$2,$3,$4::jsonb,NOW(),NOW()) ON CONFLICT(id) DO UPDATE SET client_id=EXCLUDED.client_id,name=EXCLUDED.name,data=EXCLUDED.data,updated_at=NOW()`,[id,cid,name,JSON.stringify(data)]);const out={id,clientId:cid,name,updatedAt:new Date().toISOString()};liveBroadcast('diagram',{action:'saved',...out});res.json({ok:true,...out})}catch(e){res.status(500).json({ok:false,message:'Diagram save failed',detail:e.message})}});
app.get('/api/db-meta',async(_req,res)=>{try{const r=await pool.query('SELECT version,updated_at FROM wipko_app_state WHERE id=1');res.set('Cache-Control','no-store');if(!r.rowCount)return res.json({ok:true,version:0,empty:true});res.json({ok:true,version:Number(r.rows[0].version||0),updatedAt:r.rows[0].updated_at})}catch(e){console.error('DB meta failed:',e);res.status(500).json({ok:false,message:'Database metadata unavailable'})}});
app.get('/api/dashboard',async(_q,res)=>{try{const r=await pool.query('SELECT version,data,updated_at FROM wipko_dashboard_state WHERE id=1');if(!r.rowCount)return res.json({ok:true,version:0,data:{}});res.set('Cache-Control','no-store');res.json({ok:true,version:Number(r.rows[0].version||0),data:r.rows[0].data||{},updatedAt:r.rows[0].updated_at})}catch(e){console.error('Dashboard summary failed:',e);res.status(500).json({ok:false,message:'Dashboard summary unavailable'})}});
app.get('/api/db',async(req,res)=>{const started=Date.now();try{const meta=await pool.query('SELECT version,updated_at FROM wipko_app_state WHERE id=1');if(!meta.rowCount)return res.json({version:0,db:null,empty:true});const version=Number(meta.rows[0].version||0),etag='\"wipko-db-v'+version+'\"';res.set('ETag',etag);res.set('Cache-Control','private, max-age=0, must-revalidate');if(String(req.headers['if-none-match']||'')===etag){res.set('Server-Timing','db;dur='+(Date.now()-started));return res.status(304).end()}const r=await pool.query('SELECT data,pg_column_size(data) AS db_bytes FROM wipko_app_state WHERE id=1');const body=JSON.stringify({version,db:r.rows[0].data,updatedAt:meta.rows[0].updated_at}),bytes=Buffer.byteLength(body);res.set('X-Wipko-DB-Bytes',String(bytes));res.set('X-Wipko-PG-Bytes',String(Number(r.rows[0].db_bytes||0)));res.set('Server-Timing','db;dur='+(Date.now()-started));console.log('[v044 /api/db] version=%s json=%sMB stored=%sMB build=%sms',version,(bytes/1048576).toFixed(2),(Number(r.rows[0].db_bytes||0)/1048576).toFixed(2),Date.now()-started);res.type('application/json').send(body)}catch(e){console.error(e);res.status(500).json({message:'Database read failed'})}});
app.get('/api/db-stats',async(_q,res)=>{try{const r=await pool.query('SELECT version,data,updated_at,pg_column_size(data) AS db_bytes FROM wipko_app_state WHERE id=1');if(!r.rowCount)return res.json({ok:true,empty:true});const db=r.rows[0].data||{},collections={};for(const [k,v] of Object.entries(db)){if(Array.isArray(v)){let chars=0;try{chars=JSON.stringify(v).length}catch(_e){}collections[k]={rows:v.length,approxBytes:chars}}}const sorted=Object.entries(collections).sort((a,b)=>b[1].approxBytes-a[1].approxBytes);const jsonBytes=Buffer.byteLength(JSON.stringify(db));res.set('Cache-Control','no-store');res.json({ok:true,version:Number(r.rows[0].version||0),jsonBytes,dbBytes:Number(r.rows[0].db_bytes||0),pgBytes:Number(r.rows[0].db_bytes||0),updatedAt:r.rows[0].updated_at,largestCollections:sorted.slice(0,15).map(([name,x])=>({name,rows:x.rows,approxBytes:x.approxBytes}))})}catch(e){console.error('DB stats failed:',e);res.status(500).json({ok:false,message:'DB stats unavailable'})}});
function jsonBytes(v){try{return Buffer.byteLength(JSON.stringify(v==null?null:v))}catch(_e){return 0}}
function fieldStats(rows){const fields=new Map();for(const row of(Array.isArray(rows)?rows:[])){if(!row||typeof row!=='object'||Array.isArray(row))continue;for(const [name,value] of Object.entries(row)){const bytes=jsonBytes(value),old=fields.get(name)||{name,approxBytes:0,rowsWithField:0,maxBytes:0,dataUriRows:0,longStringRows:0};old.approxBytes+=bytes;old.rowsWithField++;if(bytes>old.maxBytes)old.maxBytes=bytes;if(typeof value==='string'){if(value.startsWith('data:'))old.dataUriRows++;if(value.length>100000)old.longStringRows++}fields.set(name,old)}}return [...fields.values()].sort((a,b)=>b.approxBytes-a.approxBytes)}
app.get('/api/db-field-stats',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({ok:false,message:'Login required'});const r=await pool.query('SELECT version,data,updated_at FROM wipko_app_state WHERE id=1');if(!r.rowCount)return res.json({ok:true,empty:true});const db=r.rows[0].data||{},targets=['users','clients','cctv'],collections=[];for(const name of targets){const rows=Array.isArray(db[name])?db[name]:[],total=jsonBytes(rows),fields=fieldStats(rows);collections.push({name,rows:rows.length,approxBytes:total,fields:fields.slice(0,30)})}res.set('Cache-Control','no-store');res.json({ok:true,version:Number(r.rows[0].version||0),updatedAt:r.rows[0].updated_at,note:'Read-only size diagnostics. Values/content are not returned.',collections})}catch(e){console.error('DB field stats failed:',e);res.status(500).json({ok:false,message:'DB field stats unavailable'})}});
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
function patchRowId(r,i){if(!r||typeof r!=='object')return String(i);if(r.col&&r.id)return String(r.col)+'|'+String(r.id);return String(r.id||r.username||r.invoiceNo||r.no||r.code||i)}
app.post('/api/sync',async(req,res)=>{
 const sess=verifySession(req);if(!sess)return res.status(401).json({ok:false,message:'Login required'});
 const baseVersion=Number(req.body&&req.body.baseVersion||0),source=String(req.body&&req.body.source||sess.username||'web'),changes=req.body&&req.body.changes||{},client=await pool.connect();
 try{await client.query('BEGIN');const cur=await client.query('SELECT version,data FROM wipko_app_state WHERE id=1 FOR UPDATE');if(!cur.rowCount){await client.query('ROLLBACK');return res.status(409).json({ok:false,message:'Cloud database not initialized'})}
   const currentVersion=Number(cur.rows[0].version||0),db=cur.rows[0].data||{},conflicts=[],applied={collections:{},replace:{}};
   const cols=changes.collections&&typeof changes.collections==='object'?changes.collections:{};
   for(const [col,ch] of Object.entries(cols)){
     const arr=Array.isArray(db[col])?db[col]:[],idx=new Map(arr.map((r,i)=>[patchRowId(r,i),i])),ups=Array.isArray(ch&&ch.upserts)?ch.upserts:[],dels=Array.isArray(ch&&ch.deletes)?ch.deletes:[],aout={upserts:[],deletes:[]};
     for(const u of ups){const rec=u&&u.record;if(!rec||typeof rec!=='object')continue;const k=patchRowId(rec,0),i=idx.has(k)?idx.get(k):-1,old=i>=0?arr[i]:null,expected=Number(u.baseRev||0),actual=Number(old&&old._rev||0);if((old&&actual!==expected)||(!old&&expected>0)){conflicts.push({collection:col,id:k});continue}const clean=await sanitizeRecordForCloud(col,rec,client),stamped=stamp(clean,old,source);if(i>=0)arr[i]=stamped;else{arr.push(stamped);idx.set(k,arr.length-1)}aout.upserts.push(stamped)}
     for(const d of dels){const k=String(d&&d.id||''),i=idx.has(k)?idx.get(k):-1;if(i<0)continue;const old=arr[i],expected=Number(d.baseRev||0),actual=Number(old&&old._rev||0);if(actual!==expected){conflicts.push({collection:col,id:k});continue}arr.splice(i,1);idx.clear();arr.forEach((r,j)=>idx.set(patchRowId(r,j),j));aout.deletes.push(k)}
     db[col]=arr;if(aout.upserts.length||aout.deletes.length)applied.collections[col]=aout;
   }
   const repl=changes.replace&&typeof changes.replace==='object'?changes.replace:{};if(Object.keys(repl).length&&baseVersion!==currentVersion)conflicts.push({collection:'__root__',id:'version'});else for(const [k,v] of Object.entries(repl)){db[k]=v;applied.replace[k]=v}
   if(conflicts.length){await client.query('ROLLBACK');return res.status(409).json({ok:false,conflict:true,currentVersion,conflicts,message:'Cloud data changed on another PC. The same record must be reloaded before saving.'})}
   const next=currentVersion+1,finalDb=prune(db);await client.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[next,JSON.stringify(finalDb),source]);await syncFastState(finalDb,next,client);await client.query('COMMIT');const patch={version:next,source,changes:applied};liveBroadcast('sync',patch);res.json({ok:true,version:next,patch})
 }catch(e){try{await client.query('ROLLBACK')}catch(_e){}console.error('Delta sync failed:',e);res.status(500).json({ok:false,message:'Cloud sync failed',detail:e.message})}finally{client.release()}
});
app.post('/api/db',async(req,res)=>{
 const sess=verifySession(req);if(!sess){console.warn('[WipkoERP v044] Blocked unauthenticated /api/db save');return res.status(401).json({ok:false,message:'Login required'})}
 const incoming=req.body&&req.body.db;
 if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({message:'Invalid ERP database payload'});
 const source=String(req.body.source||incoming.__client||'web'),suppliedVersion=Number(req.body.version||0),client=await pool.connect();
 const started=Date.now();
 try{
  await client.query('BEGIN');
  const finalDb=prune(await sanitizeWholeDb(incoming,client)),json=JSON.stringify(finalDb);
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
  liveBroadcast('reload',{version:next,source});
  console.log('[v044 /api/db direct save] version=%s payload=%sMB duration=%sms',next,(Buffer.byteLength(json)/1048576).toFixed(2),Date.now()-started);
  res.json({ok:true,version:next,merged:false,conflict:false,conflicts:[]});
 }catch(e){
  try{await client.query('ROLLBACK')}catch(_e){}
  console.error('Database save failed:',e);
  res.status(500).json({message:'Database save failed',detail:e.message});
 }finally{client.release()}
});
app.post('/api/reset-business',async(req,res)=>{const sess=verifySession(req);if(!sess)return res.status(401).json({ok:false,message:'Login required'});const incoming=req.body&&req.body.db;if(!incoming||typeof incoming!=='object'||Array.isArray(incoming))return res.status(400).json({message:'Invalid reset database payload'});const source=String(req.body.source||'WipkoERP_v28_complete_reset'),client=await pool.connect();try{await client.query('BEGIN');const cur=await client.query('SELECT version,data FROM wipko_app_state WHERE id=1 FOR UPDATE');let next=1;if(cur.rowCount){const cv=Number(cur.rows[0].version||0),current=cur.rows[0].data||{};next=cv+1;await client.query('INSERT INTO wipko_state_backups(version,data,source) VALUES($1,$2::jsonb,$3)',[cv,JSON.stringify(current),'pre-complete-reset']);await client.query('DELETE FROM wipko_state_backups WHERE id NOT IN (SELECT id FROM wipko_state_backups ORDER BY id DESC LIMIT '+BACKUP_KEEP+')');await client.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[next,JSON.stringify(incoming),source])}else{await client.query('INSERT INTO wipko_app_state(id,version,data,updated_by) VALUES(1,$1,$2::jsonb,$3)',[next,JSON.stringify(incoming),source])}await syncFastState(incoming,next,client);await client.query('COMMIT');res.json({ok:true,reset:true,version:next,db:incoming})}catch(e){try{await client.query('ROLLBACK')}catch(_e){}console.error('Business reset failed:',e);res.status(500).json({message:'Business reset failed',detail:e.message})}finally{client.release()}});
app.post('/api/restore-bundle',async(req,res)=>{
 const sess=verifySession(req);if(!sess)return res.status(401).json({ok:false,message:'Login required'});
 const bundle=req.body&&typeof req.body==='object'?req.body:{},incoming=bundle.db&&typeof bundle.db==='object'?bundle.db:null;if(!incoming||Array.isArray(incoming))return res.status(400).json({ok:false,message:'Invalid Wipko backup database'});
 const client=await pool.connect();try{await client.query('BEGIN');
   if(Array.isArray(bundle.media)){await client.query('DELETE FROM wipko_media');for(const m of bundle.media){if(!m||!m.id)continue;await client.query(`INSERT INTO wipko_media(id,owner_type,owner_id,field_name,mime_type,data,updated_at) VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW())) ON CONFLICT(id) DO UPDATE SET owner_type=EXCLUDED.owner_type,owner_id=EXCLUDED.owner_id,field_name=EXCLUDED.field_name,mime_type=EXCLUDED.mime_type,data=EXCLUDED.data,updated_at=EXCLUDED.updated_at`,[String(m.id),String(m.owner_type||m.ownerType||''),String(m.owner_id||m.ownerId||''),String(m.field_name||m.fieldName||''),String(m.mime_type||m.mimeType||'application/octet-stream'),String(m.data||''),m.updated_at||m.updatedAt||null])}}
   if(Array.isArray(bundle.diagrams)){await client.query('DELETE FROM wipko_diagrams');for(const d of bundle.diagrams){if(!d||!d.id)continue;await client.query(`INSERT INTO wipko_diagrams(id,client_id,name,data,saved_at,updated_at) VALUES($1,$2,$3,$4::jsonb,COALESCE($5::timestamptz,NOW()),COALESCE($6::timestamptz,NOW())) ON CONFLICT(id) DO UPDATE SET client_id=EXCLUDED.client_id,name=EXCLUDED.name,data=EXCLUDED.data,saved_at=EXCLUDED.saved_at,updated_at=EXCLUDED.updated_at`,[String(d.id),String(d.client_id||d.clientId||''),String(d.name||'CCTV Diagram'),JSON.stringify(d.data&&typeof d.data==='object'?d.data:{}),d.saved_at||d.savedAt||null,d.updated_at||d.updatedAt||null])}}
   const clean=prune(await sanitizeWholeDb(incoming,client)),cur=await client.query('SELECT version FROM wipko_app_state WHERE id=1 FOR UPDATE'),next=(cur.rowCount?Number(cur.rows[0].version||0):0)+1,json=JSON.stringify(clean);
   if(cur.rowCount)await client.query('UPDATE wipko_app_state SET version=$1,data=$2::jsonb,updated_at=NOW(),updated_by=$3 WHERE id=1',[next,json,'restore:'+String(sess.username||'web')]);else await client.query('INSERT INTO wipko_app_state(id,version,data,updated_by) VALUES(1,$1,$2::jsonb,$3)',[next,json,'restore:'+String(sess.username||'web')]);
   await syncFastState(clean,next,client);await client.query('COMMIT');liveBroadcast('reload',{version:next,source:'restore'});res.json({ok:true,version:next,mediaRestored:Array.isArray(bundle.media)?bundle.media.length:null,diagramsRestored:Array.isArray(bundle.diagrams)?bundle.diagrams.length:null})
 }catch(e){try{await client.query('ROLLBACK')}catch(_e){}console.error('Bundle restore failed:',e);res.status(500).json({ok:false,message:'Backup restore failed',detail:e.message})}finally{client.release()}
});
app.get('/api/backup',async(req,res)=>{try{if(!verifySession(req))return res.status(401).json({message:'Login required'});const r=await pool.query('SELECT version,data FROM wipko_app_state WHERE id=1');if(!r.rowCount)return res.status(404).json({message:'No cloud data yet'});const stamp=new Date().toISOString().replace(/[:.]/g,'-');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="WipkoERP_Cloud_Backup_${stamp}.json"`);const dg=await pool.query('SELECT id,client_id,name,data,saved_at,updated_at FROM wipko_diagrams ORDER BY updated_at'),md=await pool.query('SELECT id,owner_type,owner_id,field_name,mime_type,data,updated_at FROM wipko_media ORDER BY owner_type,owner_id,field_name');res.send(JSON.stringify({application:'WipkoERP_Cloud_v044',version:Number(r.rows[0].version),createdAt:new Date().toISOString(),db:r.rows[0].data,diagrams:dg.rows,media:md.rows},null,2))}catch(e){res.status(500).json({message:'Backup failed'})}});
app.use((req,res,next)=>{if(req.path==='/'||req.path.endsWith('/index.html')){res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.set('Pragma','no-cache');res.set('Expires','0');res.set('Surrogate-Control','no-store')}next()});app.use(express.static(path.join(__dirname,'public'),{maxAge:'7d',etag:true,setHeaders:(res,filePath)=>{if(/(?:^|[\\/])index\.html$/i.test(filePath)){res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');return}if(/diagram-(maker\.(?:js|css|html)|header\.png|footer\.png|watermark-logo\.svg)$/i.test(filePath))res.setHeader('Cache-Control','public, max-age=604800')}}));app.get('*',(_q,res)=>{res.set('Cache-Control','no-store, no-cache, must-revalidate, proxy-revalidate');res.sendFile(path.join(__dirname,'public','index.html'))});
let dbInitReady=false,dbInitTimer=null,dbInitAttempt=0;
async function initDbResilient(){clearTimeout(dbInitTimer);if(!pool){dbInitReady=false;console.error('Database initialization skipped: GoDaddy managed MySQL is not configured.');return}try{await initDb();dbInitReady=true;dbInitAttempt=0;console.log('WipkoERP database ready')}catch(err){dbInitReady=false;dbInitAttempt++;const wait=Math.min(15000,Math.max(3000,dbInitAttempt*3000));console.error('Database initialization unavailable; retrying in '+wait+'ms:',err&&err.message?err.message:err);dbInitTimer=setTimeout(initDbResilient,wait)}}
const httpServer=app.listen(PORT,'0.0.0.0',()=>{console.log(`WipkoERP Cloud v044 (GitHub + GoDaddy MySQL) listening on ${PORT}; JSON body limit ${JSON_BODY_LIMIT}`);initDbResilient()});
httpServer.requestTimeout=10*60*1000;
httpServer.headersTimeout=65*1000;
