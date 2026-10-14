'use strict';

function env(name){
  const v=process.env[name];
  return v==null?'':String(v).trim();
}

function resolveMysqlConfig(){
  // GoDaddy Node.js Hosting managed MySQL injects DB_* variables.
  const host=env('DB_HOST')||env('MYSQL_HOST')||env('MYSQLHOST');
  const user=env('DB_USER')||env('MYSQL_USER')||env('MYSQLUSER');
  const password=env('DB_PASSWORD')||env('MYSQL_PASSWORD')||env('MYSQLPASSWORD');
  const database=env('DB_NAME')||env('MYSQL_DATABASE')||env('MYSQLDATABASE');
  const port=Number(env('DB_PORT')||env('MYSQL_PORT')||env('MYSQLPORT')||3306);
  if(host&&user&&database){
    return {host,port,user,password,database};
  }
  const url=env('MYSQL_URL')||env('DATABASE_URL');
  if(url&&/^mysql:\/\//i.test(url)){
    const u=new URL(url);
    return {
      host:u.hostname,
      port:Number(u.port||3306),
      user:decodeURIComponent(u.username||''),
      password:decodeURIComponent(u.password||''),
      database:decodeURIComponent((u.pathname||'').replace(/^\//,''))
    };
  }
  return null;
}

function tableDDL(name){
  const ddl={
    wipko_app_state:`CREATE TABLE IF NOT EXISTS wipko_app_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 1,
      data LONGTEXT NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_by VARCHAR(255) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    wipko_state_backups:`CREATE TABLE IF NOT EXISTS wipko_state_backups (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      version BIGINT NOT NULL,
      data LONGTEXT NOT NULL,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      source VARCHAR(255) NULL,
      KEY idx_wipko_backup_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    wipko_auth_users:`CREATE TABLE IF NOT EXISTS wipko_auth_users (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      username_key VARCHAR(191) NOT NULL UNIQUE,
      username VARCHAR(191) NOT NULL,
      password TEXT NOT NULL,
      name TEXT NULL,
      role VARCHAR(191) NULL,
      status VARCHAR(64) NULL,
      permissions LONGTEXT NOT NULL,
      role_enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_wipko_auth_username (username_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    wipko_dashboard_state:`CREATE TABLE IF NOT EXISTS wipko_dashboard_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      version BIGINT NOT NULL DEFAULT 0,
      data LONGTEXT NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    wipko_media:`CREATE TABLE IF NOT EXISTS wipko_media (
      id VARCHAR(255) NOT NULL PRIMARY KEY,
      owner_type VARCHAR(64) NOT NULL,
      owner_id VARCHAR(191) NOT NULL,
      field_name VARCHAR(128) NOT NULL,
      mime_type VARCHAR(191) NULL,
      data LONGTEXT NOT NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_wipko_media_owner (owner_type,owner_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    wipko_diagrams:`CREATE TABLE IF NOT EXISTS wipko_diagrams (
      id VARCHAR(191) NOT NULL PRIMARY KEY,
      client_id VARCHAR(191) NOT NULL,
      name TEXT NOT NULL,
      data LONGTEXT NOT NULL,
      saved_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY idx_wipko_diagrams_client (client_id,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
  };
  return ddl[name]||'';
}

function convertDdl(sql){
  const m=sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(wipko_[a-z_]+)/i);
  if(m){
    const s=tableDDL(m[1].toLowerCase());
    if(s)return {sql:s,params:[],special:'ddl'};
  }
  if(/^\s*CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS/i.test(sql))return {special:'noop'};
  return null;
}

function convertDistinctOn(sql){
  if(/SELECT\s+DISTINCT\s+ON\s*\(client_id\)/i.test(sql)){
    return `SELECT d.client_id,d.id,d.name,d.saved_at,d.updated_at
      FROM wipko_diagrams d
      INNER JOIN (
        SELECT client_id, MAX(updated_at) AS max_updated_at
        FROM wipko_diagrams GROUP BY client_id
      ) m ON m.client_id=d.client_id AND m.max_updated_at=d.updated_at
      ORDER BY d.client_id,d.updated_at DESC`;
  }
  return sql;
}

function convertDeleteKeep(sql){
  const m=sql.match(/DELETE\s+FROM\s+wipko_state_backups\s+WHERE\s+id\s+NOT\s+IN\s*\(SELECT\s+id\s+FROM\s+wipko_state_backups\s+ORDER\s+BY\s+id\s+DESC\s+LIMIT\s+(\d+)\)/i);
  if(!m)return sql;
  const n=Number(m[1]||10);
  return `DELETE FROM wipko_state_backups WHERE id NOT IN (
    SELECT id FROM (SELECT id FROM wipko_state_backups ORDER BY id DESC LIMIT ${n}) AS keep_rows
  )`;
}

function convertConflict(sql){
  let s=sql;
  s=s.replace(/ON\s+CONFLICT\s*\(\s*id\s*\)\s*DO\s+NOTHING/ig,'ON DUPLICATE KEY UPDATE id=id');
  s=s.replace(/ON\s+CONFLICT\s*\(\s*id\s*\)\s*DO\s+UPDATE\s+SET\s+([\s\S]*?)(?=\s+RETURNING\s+\w+\s*$|$)/ig,(_m,setClause)=>{
    const converted=setClause.replace(/EXCLUDED\.([a-zA-Z_][a-zA-Z0-9_]*)/g,'VALUES($1)');
    return 'ON DUPLICATE KEY UPDATE '+converted;
  });
  return s;
}

function normalizeParam(v){
  if(typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)){
    const d=new Date(v);
    if(!Number.isNaN(d.getTime())){
      const pad=(n,w=2)=>String(n).padStart(w,'0');
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(),3)}`;
    }
  }
  return v;
}

function convertSql(original,params){
  const ddl=convertDdl(original);
  if(ddl)return ddl;
  let sql=String(original);
  const originalSql=sql;
  if(/^\s*BEGIN\s*;?\s*$/i.test(sql))return {special:'begin'};
  if(/^\s*COMMIT\s*;?\s*$/i.test(sql))return {special:'commit'};
  if(/^\s*ROLLBACK\s*;?\s*$/i.test(sql))return {special:'rollback'};

  sql=convertDistinctOn(sql);
  sql=convertDeleteKeep(sql);
  sql=sql.replace(/pg_column_size\s*\(\s*data\s*\)/ig,'OCTET_LENGTH(data)');
  sql=sql.replace(/::\s*(jsonb|timestamptz)/ig,'');
  sql=convertConflict(sql);

  const returning=/\s+RETURNING\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*;?\s*$/i.exec(sql);
  const returningField=returning?returning[1]:'';
  if(returning)sql=sql.slice(0,returning.index);

  const ordered=[];
  sql=sql.replace(/\$(\d+)/g,(_m,n)=>{
    ordered.push(normalizeParam(params[Number(n)-1]));
    return '?';
  });

  return {sql,params:ordered,returningField,originalSql};
}

function maybeJson(v){
  if(v==null||typeof v!=='string')return v;
  const t=v.trim();
  if(!t||!((t[0]==='{'&&t[t.length-1]==='}')||(t[0]==='['&&t[t.length-1]===']')))return v;
  try{return JSON.parse(t)}catch(_e){return v}
}

function normalizeRows(rows,sql){
  if(!Array.isArray(rows))return rows;
  const s=String(sql).toLowerCase();
  return rows.map(row=>{
    const x={...row};
    if(s.includes('wipko_app_state')||s.includes('wipko_dashboard_state')||s.includes('wipko_diagrams')||s.includes('wipko_state_backups')){
      if(Object.prototype.hasOwnProperty.call(x,'data'))x.data=maybeJson(x.data);
    }
    if(s.includes('wipko_auth_users')&&Object.prototype.hasOwnProperty.call(x,'permissions'))x.permissions=maybeJson(x.permissions)||{};
    return x;
  });
}

async function executeOn(executor,originalSql,params=[]){
  const c=convertSql(originalSql,params);
  if(c.special==='noop'||c.special==='ddl'&& !c.sql)return {rows:[],rowCount:0};
  if(c.special==='begin'){
    if(typeof executor.beginTransaction==='function')await executor.beginTransaction();
    else await executor.query('START TRANSACTION');
    return {rows:[],rowCount:0};
  }
  if(c.special==='commit'){
    if(typeof executor.commit==='function')await executor.commit();
    else await executor.query('COMMIT');
    return {rows:[],rowCount:0};
  }
  if(c.special==='rollback'){
    if(typeof executor.rollback==='function')await executor.rollback();
    else await executor.query('ROLLBACK');
    return {rows:[],rowCount:0};
  }

  const [raw]=await executor.query(c.sql,c.params||[]);
  if(Array.isArray(raw))return {rows:normalizeRows(raw,c.sql),rowCount:raw.length};
  const affected=Number(raw&&raw.affectedRows||0);
  if(c.returningField){
    // The v044 server only uses RETURNING version on optimistic app-state writes.
    if(!affected)return {rows:[],rowCount:0};
    let value;
    if(c.returningField.toLowerCase()==='version'){
      const m=String(c.originalSql||'').match(/WHERE\s+id\s*=\s*1\s+AND\s+version\s*=\s*\$(\d+)/i);
      if(m)value=Number(params[Number(m[1])-1]||0)+1;
      else value=1;
    }
    return {rows:[{[c.returningField]:value}],rowCount:1,insertId:raw.insertId};
  }
  return {rows:[],rowCount:affected,insertId:raw&&raw.insertId};
}

class ClientWrapper{
  constructor(conn){this.conn=conn}
  query(sql,params){return executeOn(this.conn,sql,params)}
  release(){this.conn.release()}
}

class Pool{
  constructor(){
    const mysql=require('mysql2/promise');
    const cfg=resolveMysqlConfig();
    if(!cfg)throw new Error('GoDaddy MySQL is not configured');
    this.config=cfg;
    this.pool=mysql.createPool({
      ...cfg,
      waitForConnections:true,
      connectionLimit:Number(process.env.DB_POOL_SIZE||5),
      queueLimit:0,
      charset:'utf8mb4',
      timezone:'Z',
      enableKeepAlive:true,
      keepAliveInitialDelay:0
    });
  }
  query(sql,params){return executeOn(this.pool,sql,params)}
  async connect(){return new ClientWrapper(await this.pool.getConnection())}
  async end(){return this.pool.end()}
}

module.exports={Pool,resolveMysqlConfig,_test:{convertSql,normalizeRows,normalizeParam}};
