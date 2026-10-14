(function(){
  'use strict';
  var readyMessage='';
  function el(id){return document.getElementById(id)}
  function getDb(){
    try{
      if(typeof db!=='undefined' && db){
        if(db.db && !Array.isArray(db.users)) db=db.db;
        if(db.data && db.data.users && !Array.isArray(db.users)) db=db.data;
        return db;
      }
    }catch(e){}
    return null;
  }
  function ensureAdmin(d){
    if(!d)return false;
    if(!Array.isArray(d.users))d.users=[];
    var admin=d.users.find(function(x){return String(x.username||'').trim().toLowerCase()==='admin'});
    if(!admin){
      admin={id:'USR-1',name:'Administrator',username:'admin',password:'admin123',role:'Super Admin',status:'Active',permissions:{}};
      d.users.unshift(admin);
    }
    if(!admin.password)admin.password='admin123';
    if(!admin.role)admin.role='Super Admin';
    if(!admin.status)admin.status='Active';
    if(!admin.permissions)admin.permissions={};
    try{ if(typeof pages!=='undefined')Object.keys(pages).forEach(function(k){if(admin.permissions[k]===undefined)admin.permissions[k]=true}) }catch(e){}
    try{ if(typeof save==='function')save() }catch(e){}
    return true;
  }
  function showError(msg){
    var box=el('v30LoginError');
    if(!box){
      box=document.createElement('div');box.id='v30LoginError';
      box.style.cssText='margin-top:12px;padding:9px 12px;border-radius:10px;background:#fee2e2;color:#991b1b;font:700 13px Segoe UI,Arial;text-align:center';
      var f=el('loginForm');if(f)f.appendChild(box);
    }
    box.textContent=msg;box.style.display='block';
  }
  function hideError(){var b=el('v30LoginError');if(b)b.style.display='none'}
  function forceLogin(found){
    try{
      user=Object.assign({},found,{id:found.id,fullName:found.fullName||found.name||found.username,name:found.name||found.fullName||found.username,username:String(found.username||found.userName||'').trim().replace(/^@+/,''),role:found.role||'User'});
      try{localStorage.setItem(SESSION,JSON.stringify(user))}catch(e){}
      try{sessionStorage.setItem(SESSION,JSON.stringify(user))}catch(e){}
      el('login').classList.add('hidden');
      el('app').classList.remove('hidden');
      if(typeof start==='function')start();
      try{if(typeof log==='function')log('Login')}catch(e){}
      return true;
    }catch(e){showError('Login initialization failed: '+e.message);return false}
  }
  function waitForDb(timeout){
    return new Promise(function(resolve){
      var started=Date.now();
      (function check(){var d=getDb();if(d&&Array.isArray(d.users))return resolve(d);if(Date.now()-started>timeout)return resolve(d);setTimeout(check,80)})();
    });
  }
  async function robustLogin(e){
    if(e){e.preventDefault();e.stopImmediatePropagation();}
    hideError();
    var button=el('loginForm')&&el('loginForm').querySelector('button');
    if(button){button.disabled=true;button.dataset.oldText=button.textContent;button.textContent='Signing in...'}
    try{
      var d=await waitForDb(5000);
      if(!d){
        try{if(typeof load==='function')load()}catch(x){}
        d=getDb();
      }
      if(!d)throw new Error('Database is not ready. Restart the ERP server.');
      ensureAdmin(d);
      var username=String(el('u').value||'').trim().toLowerCase();
      var password=String(el('p').value||'');
      var found=(d.users||[]).find(function(x){return String(x.username||'').trim().toLowerCase()===username && String(x.password||'')===password && String(x.status||'Active').toLowerCase()!=='inactive'});
      if(!found){showError('Invalid username or password');return false}
      try{if(typeof roleEnabled==='function'&&!roleEnabled(found.role)){showError('This user role is disabled');return false}}catch(x){}
      return forceLogin(found);
    }catch(err){showError(err.message||'Unable to login');return false}
    finally{if(button){button.disabled=false;button.textContent=button.dataset.oldText||'Login'}}
  }
  function install(){
    var form=el('loginForm');if(!form)return;
    // Capture phase prevents older broken handlers from running first.
    form.addEventListener('submit',robustLogin,true);
    var d=getDb();if(d)ensureAdmin(d);
    var u=el('u'),p=el('p');if(u&&!u.value)u.value='admin';if(p&&!p.value)p.value='admin123';
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
  window.wipkoLoginRecovery=robustLogin;
})();