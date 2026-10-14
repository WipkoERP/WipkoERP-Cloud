import fs from 'node:fs';
import path from 'node:path';
const root=path.resolve(new URL('..',import.meta.url).pathname);
let errors=[];
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
if(!pkg.name||!pkg.version)errors.push('package.json name/version missing');
if(!pkg.main||!fs.existsSync(path.join(root,pkg.main)))errors.push('package.json main missing/not found');
if(!pkg.scripts?.build||!pkg.scripts?.start)errors.push('build/start scripts required');
if(!pkg.dependencies?.mysql2)errors.push('mysql2 must be in dependencies');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
if(!server.includes('process.env.PORT'))errors.push('server must use process.env.PORT');
for(const k of ['DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD'])if(!fs.readFileSync(path.join(root,'mysql-pg-adapter.js'),'utf8').includes(k))errors.push('missing '+k+' support');
if(fs.existsSync(path.join(root,'.env')))errors.push('.env must not be deployed');
if(fs.existsSync(path.join(root,'node_modules')))errors.push('node_modules must not be deployed');
if(!fs.existsSync(path.join(root,'.npmrc')))errors.push('.npmrc missing');
if(errors.length){console.error(errors.join('\n'));process.exit(1)}
console.log('GoDaddy hosting validation: PASS');
