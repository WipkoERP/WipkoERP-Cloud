// WipkoERP v9: responsive-only release; Diagram Maker business logic unchanged.
(() => {
  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d'); ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
  const brandImg = new Image(); brandImg.src = 'diagram-header-v33.png'; brandImg.onload = () => draw();
  const footerImg = new Image(); footerImg.src = 'diagram-footer-v33.png'; footerImg.onload = () => draw();
  const watermarkImg = new Image(); watermarkImg.src = 'diagram-watermark-logo-v33.svg'; watermarkImg.onload = () => draw();
  const PAPER = {
    A4:{w:1123,h:794,pdfW:842,pdfH:595},
    A3:{w:1588,h:1123,pdfW:1191,pdfH:842},
    A2:{w:2246,h:1588,pdfW:1684,pdfH:1191}
  };
  const state = {tool:'select',objects:[],selected:null,bg:null,bgData:null,grid:true,snap:true,gridSize:20,drag:null,history:[],future:[],paper:'A3',zoom:1,pan:null,pages:[],currentPage:0,clientId:'',diagramId:''};
  const imageCache=new Map();
  const $ = id => document.getElementById(id);
  const clone = o => JSON.parse(JSON.stringify(o));
  const uid = () => Math.random().toString(36).slice(2,10);
  function layoutMetrics(){
    const headerH=Math.round(canvas.height*.11), footerH=Math.round(canvas.height*.075);
    const margin=Math.round(canvas.width*.028), gap=Math.round(canvas.width*.018);
    const contentTop=headerH+Math.round(canvas.height*.045), contentBottom=canvas.height-footerH-Math.round(canvas.height*.025);
    const contentH=contentBottom-contentTop;
    const usableW=canvas.width-2*margin;
    const sideW=Math.round(usableW*.22);
    const mainW=usableW-sideW-gap;
    return {headerH,footerH,margin,gap,contentTop,contentBottom,contentH,mainX:margin,mainY:contentTop,mainW,mainH:contentH,sideX:margin+mainW+gap,sideY:contentTop,sideW,sideH:contentH};
  }
  const planWidth = () => layoutMetrics().mainX + layoutMetrics().mainW;
  const snap = v => state.snap ? Math.round(v/state.gridSize)*state.gridSize : v;
  const point = e => { const r=canvas.getBoundingClientRect(); return {x:(e.clientX-r.left)*canvas.width/r.width,y:(e.clientY-r.top)*canvas.height/r.height}; };
  const esc=s=>String(s??'').replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]));

  function meta(){return {client:$('clientName').value,project:$('projectName').value,site:$('siteLocation').value,drawingNo:$('drawingNo').value,preparedBy:$('preparedBy').value,date:$('drawingDate').value};}
  function capturePage(){return {paper:state.paper,objects:clone(state.objects),bgData:state.bgData,meta:meta()};}
  function syncCurrentPage(){state.pages[state.currentPage]=capturePage();}
  function updatePageUI(){const sel=$('pageSelect');sel.innerHTML=state.pages.map((_,i)=>`<option value="${i}" ${i===state.currentPage?'selected':''}>Page ${i+1}</option>`).join('');$('deletePageBtn').disabled=state.pages.length<=1;}
  function loadPage(i){if(i<0||i>=state.pages.length)return;state.currentPage=i;const d=state.pages[i];state.objects=clone(d.objects||[]);state.paper=d.paper||'A3';$('paperSize').value=state.paper;resizePaper(false);applyMeta(d.meta||{});loadBgData(d.bgData||null);state.selected=null;state.history=[];state.future=[];updateProps();updateSchedule();updatePageUI();draw();}
  function newBlankPage(){return {paper:state.paper,objects:[],bgData:null,meta:{...meta(),project:$('projectName').value}};}
  function projectData(){syncCurrentPage();return {version:8,pages:clone(state.pages),currentPage:state.currentPage,meta:meta(),clientId:state.clientId,diagramId:state.diagramId};}
  function bridge(){try{return window.parent&&window.parent!==window&&window.parent.WipkoDiagramBridge?window.parent.WipkoDiagramBridge:null}catch(e){return null}}
  function refreshClients(){const b=bridge(),list=b?b.clients():[];$('clientOptions').innerHTML=list.map(c=>`<option value="${esc(c.name)}"></option>`).join('');const name=$('clientName').value.trim().toLowerCase(),m=list.find(c=>String(c.name).trim().toLowerCase()===name);state.clientId=m?m.id:'';refreshSavedDiagrams();}
  function refreshSavedDiagrams(preferredId){const b=bridge(),sel=$('savedDiagramSelect');const keep=preferredId||sel.value||state.diagramId||'';const list=b&&state.clientId?b.list(state.clientId):[];sel.innerHTML='<option value="">Select saved diagram</option>'+list.map(d=>`<option value="${esc(d.id)}">${esc(d.name)}${d.updatedAt?' · '+esc(String(d.updatedAt).slice(0,10)):''}</option>`).join('');if(keep&&list.some(d=>String(d.id)===String(keep))){sel.value=keep;state.diagramId=keep}else if(state.diagramId&&!list.some(d=>String(d.id)===String(state.diagramId))){state.diagramId='';}}
  function snapshot(){state.history.push(JSON.stringify({objects:state.objects,bgData:state.bgData,paper:state.paper,meta:meta()}));if(state.history.length>60)state.history.shift();state.future=[];}
  function applyMeta(m={}){$('clientName').value=m.client||'';$('projectName').value=m.project||'';$('siteLocation').value=m.site||'';$('drawingNo').value=m.drawingNo||'';$('preparedBy').value=m.preparedBy||'';$('drawingDate').value=m.date||'';}
  function restore(raw){const d=JSON.parse(raw);state.objects=d.objects||[];state.paper=d.paper||'A3';$('paperSize').value=state.paper;resizePaper(false);applyMeta(d.meta);loadBgData(d.bgData);state.selected=null;updateProps();updateSchedule();draw();}
  function undo(){if(!state.history.length)return;state.future.push(JSON.stringify({objects:state.objects,bgData:state.bgData,paper:state.paper,meta:meta()}));restore(state.history.pop());}
  function redo(){if(!state.future.length)return;state.history.push(JSON.stringify({objects:state.objects,bgData:state.bgData,paper:state.paper,meta:meta()}));restore(state.future.pop());}

  function resizePaper(redraw=true){const p=PAPER[state.paper];canvas.width=p.w;canvas.height=p.h;if(redraw)draw();}
  function roundRectPath(x,y,w,h,r){ctx.beginPath();ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}
  function drawGrid(){if(!state.grid)return;const L=layoutMetrics();ctx.save();roundRectPath(L.mainX,L.mainY,L.mainW,L.mainH,14);ctx.clip();ctx.strokeStyle='#e7edf3';ctx.lineWidth=1;ctx.beginPath();for(let x=L.mainX+state.gridSize;x<L.mainX+L.mainW;x+=state.gridSize){ctx.moveTo(x,L.mainY);ctx.lineTo(x,L.mainY+L.mainH)}for(let y=L.mainY+state.gridSize;y<L.mainY+L.mainH;y+=state.gridSize){ctx.moveTo(L.mainX,y);ctx.lineTo(L.mainX+L.mainW,y)}ctx.stroke();ctx.restore();}
  function drawCameraIcon(o){
    const t=o.cameraType||'Bullet';ctx.save();ctx.translate(o.x,o.y);ctx.rotate(o.angle*Math.PI/180);ctx.lineWidth=2;ctx.strokeStyle='#374151';ctx.fillStyle='#6b7280';
    if(t==='Dome'){ctx.beginPath();ctx.arc(0,1,14,Math.PI,0);ctx.lineTo(14,7);ctx.lineTo(-14,7);ctx.closePath();ctx.fill();ctx.fillStyle='#111827';ctx.beginPath();ctx.arc(0,2,6,0,Math.PI*2);ctx.fill();}
    else if(t==='PTZ'){ctx.fillRect(-12,-12,24,9);ctx.beginPath();ctx.arc(0,4,12,0,Math.PI);ctx.fill();ctx.fillStyle='#111827';ctx.beginPath();ctx.arc(0,5,5,0,Math.PI*2);ctx.fill();}
    else if(t==='Fisheye'){ctx.fillStyle='#e5e7eb';ctx.beginPath();ctx.arc(0,0,15,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#111827';ctx.beginPath();ctx.arc(0,0,8,0,Math.PI*2);ctx.fill();}
    else if(t==='ANPR'){ctx.fillRect(-14,-9,25,18);ctx.fillStyle='#111827';ctx.fillRect(8,-6,13,12);ctx.fillStyle='#f59e0b';ctx.fillRect(-18,-5,4,10);}
    else {ctx.fillRect(-15,-9,26,18);ctx.fillStyle='#111827';ctx.fillRect(8,-6,13,12);ctx.fillStyle='#9ca3af';ctx.fillRect(-20,-5,5,10);ctx.strokeStyle='#4b5563';ctx.beginPath();ctx.moveTo(-8,9);ctx.lineTo(-12,17);ctx.stroke();}
    ctx.restore();
  }
  function drawCamera(o){ctx.save();ctx.translate(o.x,o.y);ctx.rotate(o.angle*Math.PI/180);const a=o.fov*Math.PI/360,r=o.range;ctx.beginPath();ctx.moveTo(0,0);ctx.arc(0,0,r,-a,a);ctx.closePath();ctx.fillStyle=hexToRgba(o.color,o.opacity);ctx.fill();ctx.strokeStyle=o.color;ctx.globalAlpha=.8;ctx.lineWidth=1.5;ctx.stroke();ctx.restore();drawCameraIcon(o);if(o.showLabel){ctx.save();ctx.fillStyle='#111827';ctx.font='bold 15px Segoe UI';ctx.fillText(o.id,o.x+14,o.y-17);ctx.font='12px Segoe UI';ctx.fillText(o.location||o.cameraType,o.x+14,o.y+1);ctx.restore();}}
  function drawLine(o){ctx.save();ctx.strokeStyle=o.color;ctx.lineWidth=o.width;ctx.lineCap='round';ctx.beginPath();ctx.moveTo(o.x1,o.y1);ctx.lineTo(o.x2,o.y2);ctx.stroke();ctx.restore();}
  function drawSquare(o){ctx.save();ctx.strokeStyle=o.color||'#333333';ctx.lineWidth=o.width||3;ctx.fillStyle=o.fill||'rgba(255,255,255,0)';const x=Math.min(o.x1,o.x2),y=Math.min(o.y1,o.y2),w=Math.abs(o.x2-o.x1),h=Math.abs(o.y2-o.y1);ctx.fillRect(x,y,w,h);ctx.strokeRect(x,y,w,h);ctx.restore();}
  function drawDoor(o){
    ctx.save();const color=o.color||'#111827',lw=Math.max(2,o.width||3),dx=o.x2-o.x1,dy=o.y2-o.y1,r=Math.max(24,Math.hypot(dx,dy)),open=Math.atan2(dy,dx),closed=open-Math.PI/2;
    const cx=o.x1+Math.cos(closed)*r,cy=o.y1+Math.sin(closed)*r,stub=Math.max(20,Math.min(46,r*.24));
    ctx.strokeStyle=color;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.lineWidth=lw*2.2;ctx.beginPath();ctx.moveTo(o.x1-Math.cos(closed)*stub,o.y1-Math.sin(closed)*stub);ctx.lineTo(o.x1,o.y1);ctx.stroke();
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(cx+Math.cos(closed)*stub,cy+Math.sin(closed)*stub);ctx.stroke();
    ctx.lineWidth=lw;ctx.beginPath();ctx.moveTo(o.x1,o.y1);ctx.lineTo(o.x2,o.y2);ctx.stroke();
    ctx.setLineDash([5,4]);ctx.lineWidth=Math.max(1,lw*.7);ctx.beginPath();ctx.arc(o.x1,o.y1,r,closed,open,false);ctx.stroke();ctx.setLineDash([]);
    ctx.restore();
  }
  function imageCropBox(o){const l=Math.min(90,Math.max(0,+o.cropLeft||0))/100,r=Math.min(90,Math.max(0,+o.cropRight||0))/100,t=Math.min(90,Math.max(0,+o.cropTop||0))/100,b=Math.min(90,Math.max(0,+o.cropBottom||0))/100;const fx=Math.max(.01,1-l-r),fy=Math.max(.01,1-t-b);return {l,r,t,b,fx,fy,x:-o.w/2+o.w*l,y:-o.h/2+o.h*t,w:o.w*fx,h:o.h*fy};}
  function drawImageObject(o){if(o.hidden)return;const im=imageCache.get(o.data);if(!im){const n=new Image();n.onload=()=>{imageCache.set(o.data,n);draw()};n.src=o.data;imageCache.set(o.data,n);return}if(!im.complete||!im.naturalWidth)return;const c=imageCropBox(o),sx=im.naturalWidth*c.l,sy=im.naturalHeight*c.t,sw=Math.max(1,im.naturalWidth*c.fx),sh=Math.max(1,im.naturalHeight*c.fy);ctx.save();ctx.translate(o.x,o.y);ctx.rotate((+o.angle||0)*Math.PI/180);ctx.drawImage(im,sx,sy,sw,sh,c.x,c.y,c.w,c.h);ctx.restore();}
  function drawText(o){ctx.save();ctx.fillStyle=o.color||'#111827';ctx.font=`${o.size||18}px Segoe UI`;String(o.text).split('\n').forEach((t,i)=>ctx.fillText(t,o.x,o.y+i*(o.size*1.2)));ctx.restore();}
  function drawSelection(o){ctx.save();ctx.strokeStyle='#1769ff';ctx.lineWidth=2;ctx.setLineDash([6,4]);if(o.type==='camera'){ctx.beginPath();ctx.arc(o.x,o.y,28,0,Math.PI*2);ctx.stroke();}else if(o.type==='text'){ctx.strokeRect(o.x-5,o.y-o.size-5,Math.max(80,(o.text||'').length*o.size*.55)+10,o.size*1.5+10)}else if(o.type==='image'){ctx.save();ctx.translate(o.x,o.y);ctx.rotate((+o.angle||0)*Math.PI/180);const c=imageCropBox(o);ctx.strokeRect(c.x-5,c.y-5,c.w+10,c.h+10);ctx.restore();}else{const x=Math.min(o.x1,o.x2),y=Math.min(o.y1,o.y2);ctx.strokeRect(x-5,y-5,Math.abs(o.x2-o.x1)+10,Math.abs(o.y2-o.y1)+10);ctx.setLineDash([]);ctx.fillStyle='#fff';ctx.strokeStyle='#1769ff';[[o.x1,o.y1],[o.x2,o.y2]].forEach(h=>{ctx.beginPath();ctx.arc(h[0],h[1],7,0,Math.PI*2);ctx.fill();ctx.stroke();});}ctx.restore();}
  function drawTemplate(){const L=layoutMetrics();ctx.save();
    // Clean white header: title and client on the left, WIPKO artwork on the right.
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,L.headerH);
    const titleX=L.margin;
    ctx.fillStyle='#0b2238';ctx.font=`bold ${Math.max(17,Math.round(canvas.height*.026))}px Segoe UI`;
    ctx.fillText('CCTV SURVEILLANCE PROPOSAL DIAGRAM',titleX,Math.round(L.headerH*.45));
    ctx.font=`bold ${Math.max(12,Math.round(canvas.height*.0135))}px Segoe UI`;ctx.fillStyle='#334e68';
    ctx.fillText(`Client: ${$('clientName').value||''}`,titleX,Math.round(L.headerH*.73));
    if(brandImg.complete&&brandImg.naturalWidth){
      const maxW=canvas.width*.39,maxH=L.headerH*.82;
      const scale=Math.min(maxW/brandImg.naturalWidth,maxH/brandImg.naturalHeight);
      const bw=brandImg.naturalWidth*scale,bh=brandImg.naturalHeight*scale;
      const bx=canvas.width-L.margin-bw,by=Math.max(4,(L.headerH-bh)/2);
      ctx.drawImage(brandImg,bx,by,bw,bh);
    }
    ctx.fillStyle='#11aeba';ctx.fillRect(L.margin,L.headerH-4,canvas.width-2*L.margin,4);

    ctx.fillStyle='#fff';ctx.shadowColor='rgba(15,34,56,.15)';ctx.shadowBlur=8;ctx.shadowOffsetX=4;ctx.shadowOffsetY=5;roundRectPath(L.mainX,L.mainY,L.mainW,L.mainH,16);ctx.fill();roundRectPath(L.sideX,L.sideY,L.sideW,L.sideH,16);ctx.fill();ctx.shadowColor='transparent';ctx.strokeStyle='#c8d4df';ctx.lineWidth=1.5;roundRectPath(L.mainX,L.mainY,L.mainW,L.mainH,16);ctx.stroke();roundRectPath(L.sideX,L.sideY,L.sideW,L.sideH,16);ctx.stroke();

    // Supplied footer artwork, proportionally scaled and horizontally centred at the bottom.
    const footerTop=canvas.height-L.footerH;
    if(footerImg.complete&&footerImg.naturalWidth){
      const maxW=canvas.width-2*L.margin,maxH=L.footerH*.92;
      const scale=Math.min(maxW/footerImg.naturalWidth,maxH/footerImg.naturalHeight);
      const dw=footerImg.naturalWidth*scale,dh=footerImg.naturalHeight*scale;
      const fx=(canvas.width-dw)/2,fy=footerTop+(L.footerH-dh)/2;
      ctx.drawImage(footerImg,fx,fy,dw,dh);
    }
    ctx.restore();}
  function drawInfoPanel(){const L=layoutMetrics(),x=L.sideX,w=L.sideW,m=Math.max(10,Math.round(w*.055));ctx.save();ctx.beginPath();roundRectPath(x,L.sideY,w,L.sideH,16);ctx.clip();ctx.fillStyle='#0b2238';ctx.fillRect(x,L.sideY,w,Math.round(L.sideH*.065));ctx.fillStyle='#fff';ctx.font=`bold ${Math.max(12,Math.round(canvas.height*.014))}px Segoe UI`;ctx.fillText('PROJECT DETAILS',x+m,L.sideY+Math.round(L.sideH*.042));let y=L.sideY+Math.round(L.sideH*.09);const fields=[['Project',$('projectName').value],['Site / Location',$('siteLocation').value],['Drawing No.',$('drawingNo').value],['Prepared By',$('preparedBy').value||'WIPKO Technologies LLC'],['Date',$('drawingDate').value],['Paper',`${state.paper} Landscape`]];fields.forEach(([k,v])=>{ctx.fillStyle='#73869a';ctx.font=`bold ${Math.max(8,Math.round(canvas.height*.008))}px Segoe UI`;ctx.fillText(k.toUpperCase(),x+m,y);ctx.fillStyle='#17283a';ctx.font=`${Math.max(9,Math.round(canvas.height*.0095))}px Segoe UI`;wrapText(v||'-',x+m,y+Math.round(canvas.height*.014),w-2*m,Math.round(canvas.height*.012));y+=Math.round(L.sideH*.072);});ctx.strokeStyle='#d4dee7';ctx.beginPath();ctx.moveTo(x+m,y);ctx.lineTo(x+w-m,y);ctx.stroke();y+=Math.round(L.sideH*.038);ctx.fillStyle='#0b2238';ctx.font=`bold ${Math.max(12,Math.round(canvas.height*.013))}px Segoe UI`;ctx.fillText('CAMERA SCHEDULE',x+m,y);y+=Math.round(L.sideH*.035);const cams=state.objects.filter(o=>o.type==='camera');const idX=x+m,typeX=x+m+w*.22,locX=x+m+w*.49;ctx.font=`bold ${Math.max(7,Math.round(canvas.height*.0075))}px Segoe UI`;ctx.fillText('ID',idX,y);ctx.fillText('TYPE',typeX,y);ctx.fillText('LOCATION',locX,y);y+=Math.round(canvas.height*.01);ctx.strokeStyle='#8ca1b4';ctx.beginPath();ctx.moveTo(x+m,y);ctx.lineTo(x+w-m,y);ctx.stroke();y+=Math.round(canvas.height*.014);ctx.font=`${Math.max(7,Math.round(canvas.height*.0075))}px Segoe UI`;const rowH=Math.max(20,Math.round(L.sideH*.041));cams.forEach(c=>{if(y>L.sideY+L.sideH-45)return;ctx.fillStyle='#17283a';ctx.fillText(c.id,idX,y);ctx.fillText(c.cameraType,typeX,y);wrapText(c.location||'-',locX,y,w-(locX-x)-m,rowH*.45);ctx.strokeStyle='#e1e8ee';ctx.beginPath();ctx.moveTo(x+m,y+rowH*.45);ctx.lineTo(x+w-m,y+rowH*.45);ctx.stroke();y+=rowH;});ctx.fillStyle='#607588';ctx.font=`${Math.max(8,Math.round(canvas.height*.008))}px Segoe UI`;ctx.fillText(`Total cameras: ${cams.length}`,x+m,L.sideY+L.sideH-18);ctx.restore();}
  function wrapText(text,x,y,maxWidth,lineHeight){const words=String(text).split(' ');let line='';for(const word of words){const test=line+word+' ';if(ctx.measureText(test).width>maxWidth&&line){ctx.fillText(line,x,y);line=word+' ';y+=lineHeight;}else line=test;}ctx.fillText(line,x,y);}
  function drawWatermark(){
    if(!(watermarkImg.complete&&watermarkImg.naturalWidth))return;
    const L=layoutMetrics();
    const paperWidthCm={A4:29.7,A3:42,A2:59.4}[state.paper]||42;
    const targetW=canvas.width*(8/paperWidthCm);
    const scale=targetW/watermarkImg.naturalWidth;
    const targetH=watermarkImg.naturalHeight*scale;
    const x=L.mainX+(L.mainW-targetW)/2;
    const y=L.mainY+(L.mainH-targetH)/2;
    ctx.save();
    ctx.globalAlpha=.10;
    ctx.drawImage(watermarkImg,x,y,targetW,targetH);
    ctx.restore();
  }
  function draw(){const L=layoutMetrics();ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);drawTemplate();ctx.save();roundRectPath(L.mainX,L.mainY,L.mainW,L.mainH,14);ctx.clip();if(state.bg){const scale=Math.min(L.mainW/state.bg.width,L.mainH/state.bg.height);const bw=state.bg.width*scale,bh=state.bg.height*scale;ctx.drawImage(state.bg,L.mainX+(L.mainW-bw)/2,L.mainY+(L.mainH-bh)/2,bw,bh);}ctx.restore();drawGrid();drawWatermark();ctx.save();roundRectPath(L.mainX,L.mainY,L.mainW,L.mainH,14);ctx.clip();state.objects.filter(o=>!o.hidden).forEach(o=>o.type==='camera'?drawCamera(o):o.type==='image'?drawImageObject(o):o.type==='text'?drawText(o):o.type==='square'?drawSquare(o):o.type==='door'?drawDoor(o):drawLine(o));if(state.selected&&!state.selected.hidden)drawSelection(state.selected);ctx.restore();drawInfoPanel();renderLayers();}
  function hexToRgba(hex,a){const n=parseInt(hex.replace('#',''),16);return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;}

  function objectHit(o,p){if(!o||o.hidden||o.locked)return false;if(o.type==='camera')return Math.hypot(p.x-o.x,p.y-o.y)<34;if(o.type==='image'){const c=imageCropBox(o),cx=o.x+c.x+c.w/2,cy=o.y+c.y+c.h/2;return p.x>=cx-c.w/2-8&&p.x<=cx+c.w/2+8&&p.y>=cy-c.h/2-8&&p.y<=cy+c.h/2+8}if(o.type==='text')return p.x>=o.x-5&&p.x<=o.x+Math.max(100,(o.text||'').length*o.size*.55)&&p.y>=o.y-o.size-10&&p.y<=o.y+20;if((o.type==='wall'||o.type==='door')&&distToSegment(p,{x:o.x1,y:o.y1},{x:o.x2,y:o.y2})<12)return true;if(o.type==='square'){const x=Math.min(o.x1,o.x2),y=Math.min(o.y1,o.y2),w=Math.abs(o.x2-o.x1),h=Math.abs(o.y2-o.y1);return p.x>=x-8&&p.x<=x+w+8&&p.y>=y-8&&p.y<=y+h+8}return false;}
  function hitTestAll(p){const L=layoutMetrics();if(p.x<L.mainX||p.x>L.mainX+L.mainW||p.y<L.mainY||p.y>L.mainY+L.mainH)return [];const a=[];for(let i=state.objects.length-1;i>=0;i--){if(objectHit(state.objects[i],p))a.push(state.objects[i]);}return a;}
  let lastCycleKey='',lastCycleIndex=0;function cycleHit(p){const hits=hitTestAll(p);if(!hits.length)return null;const key=Math.round(p.x/8)+':'+Math.round(p.y/8)+':'+hits.map(x=>x.uid).join(',');if(key===lastCycleKey)lastCycleIndex=(lastCycleIndex+1)%hits.length;else{lastCycleKey=key;lastCycleIndex=0}return hits[lastCycleIndex];}
  function hitTest(p){return hitTestAll(p)[0]||null;}
  function distToSegment(p,a,b){const l2=(b.x-a.x)**2+(b.y-a.y)**2;if(!l2)return Math.hypot(p.x-a.x,p.y-a.y);let t=((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/l2;t=Math.max(0,Math.min(1,t));return Math.hypot(p.x-(a.x+t*(b.x-a.x)),p.y-(a.y+t*(b.y-a.y)));}

  const near=(p,x,y,r=13)=>Math.hypot(p.x-x,p.y-y)<=r;
  canvas.addEventListener('mousedown',e=>{if(state.tool==='hand')return;const p=point(e),L=layoutMetrics();if(p.x<L.mainX||p.x>L.mainX+L.mainW||p.y<L.mainY||p.y>L.mainY+L.mainH)return;if(state.tool==='select'){let o=state.selected;if(o&&['wall','square','door'].includes(o.type)&&near(p,o.x1,o.y1)){snapshot();state.drag={mode:'resize1'};return}if(o&&['wall','square','door'].includes(o.type)&&near(p,o.x2,o.y2)){snapshot();state.drag={mode:'resize2'};return}o=e.altKey?cycleHit(p):hitTest(p);state.selected=o;updateProps();if(o&&!o.locked){snapshot();if(o.type==='camera'||o.type==='text'||o.type==='image')state.drag={mode:'move',dx:p.x-o.x,dy:p.y-o.y};else state.drag={mode:'moveLine',sx:p.x,sy:p.y,orig:clone(o)}}}else if(state.tool==='camera'){snapshot();const num=state.objects.filter(o=>o.type==='camera').length+1;const o={uid:uid(),type:'camera',x:snap(p.x),y:snap(p.y),id:`CAM-${String(num).padStart(2,'0')}`,cameraType:'Bullet',location:'',resolution:'4 MP',lens:'2.8 mm',angle:0,fov:70,range:220,opacity:.28,color:'#66aaff',showLabel:true};state.objects.push(o);state.selected=o;state.tool='select';syncToolButtons();updateProps();updateSchedule();}else if(state.tool==='text'){const text=prompt('Enter label text:','Room / Area');if(text){snapshot();const o={uid:uid(),type:'text',x:snap(p.x),y:snap(p.y),text,size:18,color:'#111827'};state.objects.push(o);state.selected=o;state.tool='select';syncToolButtons();updateProps();}}else if(state.tool==='wall'||state.tool==='square'||state.tool==='door'){snapshot();const type=state.tool;const o={uid:uid(),type,x1:snap(p.x),y1:snap(p.y),x2:snap(p.x),y2:snap(p.y),width:type==='wall'?4:3,color:'#333333'};state.objects.push(o);state.selected=o;state.drag={mode:'drawLine'};}draw();});
  canvas.addEventListener('mousemove',e=>{if(!state.drag||!state.selected)return;const p=point(e),o=state.selected,L=layoutMetrics();const px=Math.max(L.mainX+5,Math.min(p.x,L.mainX+L.mainW-5));const py=Math.max(L.mainY+5,Math.min(p.y,L.mainY+L.mainH-5));if(state.drag.mode==='move'){o.x=snap(px-state.drag.dx);o.y=snap(py-state.drag.dy)}else if(state.drag.mode==='drawLine'||state.drag.mode==='resize2'){o.x2=snap(px);o.y2=snap(py)}else if(state.drag.mode==='resize1'){o.x1=snap(px);o.y1=snap(py)}else if(state.drag.mode==='moveLine'){const dx=px-state.drag.sx,dy=py-state.drag.sy;o.x1=snap(state.drag.orig.x1+dx);o.y1=snap(state.drag.orig.y1+dy);o.x2=snap(state.drag.orig.x2+dx);o.y2=snap(state.drag.orig.y2+dy)}draw();});
  window.addEventListener('mouseup',()=>{if(state.drag){state.drag=null;updateSchedule();draw();}});

  const workspaceWrap=document.querySelector('.workspace-wrap');
  workspaceWrap.addEventListener('mousedown',e=>{if(state.tool!=='hand')return;e.preventDefault();state.pan={x:e.clientX,y:e.clientY,left:workspaceWrap.scrollLeft,top:workspaceWrap.scrollTop};workspaceWrap.classList.add('is-panning');});
  window.addEventListener('mousemove',e=>{if(!state.pan)return;workspaceWrap.scrollLeft=state.pan.left-(e.clientX-state.pan.x);workspaceWrap.scrollTop=state.pan.top-(e.clientY-state.pan.y);});
  window.addEventListener('mouseup',()=>{if(state.pan){state.pan=null;workspaceWrap.classList.remove('is-panning');}});

  document.querySelectorAll('.tool').forEach(b=>b.addEventListener('click',()=>{state.tool=b.dataset.tool;syncToolButtons();}));
  function syncToolButtons(){document.querySelectorAll('.tool').forEach(b=>b.classList.toggle('active',b.dataset.tool===state.tool));document.querySelector('.workspace-wrap').classList.toggle('hand-active',state.tool==='hand');$('status').textContent=`Tool: ${state.tool} · ${state.paper} Landscape`;}
  function duplicateSelected(){if(!state.selected)return;snapshot();const o=clone(state.selected);o.uid=uid();if(o.type==='camera'||o.type==='text'||o.type==='image'){const L=layoutMetrics();o.x=Math.min(o.x+30,L.mainX+L.mainW-30);o.y=Math.min(o.y+30,L.mainY+L.mainH-20)}else{o.x1+=30;o.x2+=30;o.y1+=30;o.y2+=30}if(o.type==='camera'){const n=state.objects.filter(x=>x.type==='camera').length+1;o.id=`CAM-${String(n).padStart(2,'0')}`;}state.objects.push(o);state.selected=o;updateProps();updateSchedule();draw();}
  if($('duplicateBtn'))$('duplicateBtn').onclick=duplicateSelected;$('duplicateBtnSide').onclick=duplicateSelected;
  $('deleteBtn').onclick=()=>{if(!state.selected)return;snapshot();state.objects=state.objects.filter(o=>o!==state.selected);state.selected=null;updateProps();updateSchedule();draw();};
  if($('undoBtn'))$('undoBtn').onclick=undo;if($('redoBtn'))$('redoBtn').onclick=redo;
  $('gridToggle').onchange=e=>{state.grid=e.target.checked;draw();};$('snapToggle').onchange=e=>state.snap=e.target.checked;$('gridSize').onchange=e=>{state.gridSize=Math.max(5,+e.target.value||20);draw();};
  $('paperSize').onchange=e=>{snapshot();state.paper=e.target.value;resizePaper();syncToolButtons();};
  const ZOOM_MIN=.2, ZOOM_MAX=2.5, ZOOM_STEP=.1;
  function applyZoom(value, keepCenter=true){
    const wrap=document.querySelector('.workspace-wrap');
    const oldW=canvas.getBoundingClientRect().width||canvas.width;
    const oldH=canvas.getBoundingClientRect().height||canvas.height;
    const centerX=wrap.scrollLeft+wrap.clientWidth/2, centerY=wrap.scrollTop+wrap.clientHeight/2;
    const rx=oldW?centerX/oldW:.5, ry=oldH?centerY/oldH:.5;
    state.zoom=Math.max(ZOOM_MIN,Math.min(ZOOM_MAX,Math.round(value*100)/100));
    canvas.style.width=`${Math.round(canvas.width*state.zoom)}px`;
    canvas.style.height=`${Math.round(canvas.height*state.zoom)}px`;
    if($('zoomValue'))$('zoomValue').textContent=`${Math.round(state.zoom*100)}%`;
    $('zoomOutBtn').disabled=state.zoom<=ZOOM_MIN;
    $('zoomInBtn').disabled=state.zoom>=ZOOM_MAX;
    if(keepCenter){requestAnimationFrame(()=>{wrap.scrollLeft=Math.max(0,canvas.offsetLeft+canvas.clientWidth*rx-wrap.clientWidth/2);wrap.scrollTop=Math.max(0,canvas.offsetTop+canvas.clientHeight*ry-wrap.clientHeight/2);});}
  }
  function zoomBy(delta){applyZoom(state.zoom+delta);}
  $('zoomOutBtn').onclick=()=>zoomBy(-ZOOM_STEP);
  $('zoomInBtn').onclick=()=>zoomBy(ZOOM_STEP);
  if($('actualSizeBtn'))$('actualSizeBtn').onclick=()=>applyZoom(1);
  $('fitBtn').onclick=()=>{const wrap=document.querySelector('.workspace-wrap');const scale=Math.min((wrap.clientWidth-44)/canvas.width,(wrap.clientHeight-44)/canvas.height,1);applyZoom(scale,false);requestAnimationFrame(()=>wrap.scrollTo({left:0,top:0,behavior:'smooth'}));};
  document.querySelector('.workspace-wrap').addEventListener('wheel',e=>{if(!(e.ctrlKey||e.metaKey))return;e.preventDefault();zoomBy(e.deltaY<0?ZOOM_STEP:-ZOOM_STEP);},{passive:false});

  function bind(id,prop,parse=v=>v){$(id).addEventListener('input',e=>{if(!state.selected)return;state.selected[prop]=parse(e.target.type==='checkbox'?e.target.checked:e.target.value);updateProps(false);updateSchedule();draw();});}
  bind('camId','id');bind('camType','cameraType');bind('camLocation','location');bind('camResolution','resolution');bind('camLens','lens');bind('camAngle','angle',Number);bind('camFov','fov',Number);bind('camRange','range',Number);bind('camOpacity','opacity',v=>Number(v)/100);bind('camColor','color');bind('showLabel','showLabel',Boolean);bind('textValue','text');bind('textSize','size',Number);bind('lineWidth','width',Number);bind('lineColor','color');bind('imageAngle','angle',Number);bind('cropLeft','cropLeft',Number);bind('cropRight','cropRight',Number);bind('cropTop','cropTop',Number);bind('cropBottom','cropBottom',Number);
  function resizeImageProp(which,value){const o=state.selected;if(!o||o.type!=='image')return;let v=Math.max(20,Number(value)||20);if(!o.aspectRatio)o.aspectRatio=(o.w||1)/(o.h||1);snapshot();if(which==='w'){o.w=v;if(o.lockAspect!==false)o.h=v/o.aspectRatio}else{o.h=v;if(o.lockAspect!==false)o.w=v*o.aspectRatio}updateProps();draw();}
  $('imageWidth').addEventListener('change',e=>resizeImageProp('w',e.target.value));$('imageHeight').addEventListener('change',e=>resizeImageProp('h',e.target.value));
  $('lockImageRatio').addEventListener('change',e=>{const o=state.selected;if(o&&o.type==='image'){o.lockAspect=e.target.checked;if(o.lockAspect)o.aspectRatio=(o.w||1)/(o.h||1);}});
  $('resetCropBtn').onclick=()=>{const o=state.selected;if(!o||o.type!=='image')return;snapshot();o.cropLeft=o.cropRight=o.cropTop=o.cropBottom=0;updateProps();draw();};
  function layerName(o,i){if(o.type==='camera')return o.id||('Camera '+(i+1));if(o.type==='text')return 'Text: '+String(o.text||'').slice(0,18);if(o.type==='image')return 'Image '+(i+1);if(o.type==='square')return 'Square '+(i+1);if(o.type==='door')return 'Door '+(i+1);return 'Wall '+(i+1)}
  function renderLayers(){const box=$('layersList');if(!box)return;box.innerHTML=state.objects.slice().reverse().map((o,ri)=>{const i=state.objects.length-1-ri;return `<div class="layer-row ${state.selected===o?'active':''} ${o.locked?'locked':''}" data-uid="${esc(o.uid)}"><button type="button" data-eye="${esc(o.uid)}" title="Show / hide">${o.hidden?'○':'◉'}</button><button type="button" data-lock="${esc(o.uid)}" title="Lock / unlock">${o.locked?'🔒':'🔓'}</button><span class="layer-name">${esc(layerName(o,i))}</span></div>`}).join('')||'<div class="muted">No objects yet.</div>';box.querySelectorAll('.layer-row').forEach(r=>r.onclick=e=>{if(e.target.tagName==='BUTTON')return;const o=state.objects.find(x=>x.uid===r.dataset.uid);if(o){state.selected=o;updateProps();draw()}});box.querySelectorAll('[data-eye]').forEach(b=>b.onclick=e=>{e.stopPropagation();const o=state.objects.find(x=>x.uid===b.dataset.eye);if(o){snapshot();o.hidden=!o.hidden;if(o.hidden&&state.selected===o)state.selected=null;updateProps();draw()}});box.querySelectorAll('[data-lock]').forEach(b=>b.onclick=e=>{e.stopPropagation();const o=state.objects.find(x=>x.uid===b.dataset.lock);if(o){o.locked=!o.locked;draw()}})}
  function moveLayer(kind){const o=state.selected;if(!o)return;let i=state.objects.indexOf(o);if(i<0)return;snapshot();state.objects.splice(i,1);if(kind==='front')state.objects.push(o);else if(kind==='back')state.objects.unshift(o);else if(kind==='forward')state.objects.splice(Math.min(state.objects.length,i+1),0,o);else state.objects.splice(Math.max(0,i-1),0,o);draw();}
  $('bringFrontBtn').onclick=()=>moveLayer('front');$('bringForwardBtn').onclick=()=>moveLayer('forward');$('sendBackwardBtn').onclick=()=>moveLayer('backward');$('sendBackBtn').onclick=()=>moveLayer('back');
  ['clientName','projectName','siteLocation','drawingNo','preparedBy','drawingDate'].forEach(id=>$(id).addEventListener('input',draw));
  $('clientName').addEventListener('change',()=>{refreshClients();draw();});
  $('savedDiagramSelect').addEventListener('change',e=>{state.diagramId=e.target.value||'';});
  function updateProps(fill=true){['cameraProps','imageProps','textProps','lineProps'].forEach(id=>$(id).classList.add('hidden'));$('emptyProps').classList.toggle('hidden',!!state.selected);if(!state.selected)return;const o=state.selected;if(o.type==='camera'){$('cameraProps').classList.remove('hidden');if(fill){$('camId').value=o.id;$('camType').value=o.cameraType;$('camLocation').value=o.location;$('camResolution').value=o.resolution;$('camLens').value=o.lens;$('camAngle').value=o.angle;$('camFov').value=o.fov;$('camRange').value=o.range;$('camOpacity').value=Math.round(o.opacity*100);$('camColor').value=o.color;$('showLabel').checked=o.showLabel;}$('camAngleVal').textContent=`${o.angle}°`;$('camFovVal').textContent=`${o.fov}°`;$('camRangeVal').textContent=`${o.range}px`;$('camOpacityVal').textContent=`${Math.round(o.opacity*100)}%`;}else if(o.type==='image'){$('imageProps').classList.remove('hidden');if(fill){$('imageWidth').value=Math.round(o.w);$('imageHeight').value=Math.round(o.h);if(!o.aspectRatio)o.aspectRatio=(o.w||1)/(o.h||1);$('lockImageRatio').checked=o.lockAspect!==false;$('imageAngle').value=o.angle||0;$('cropLeft').value=o.cropLeft||0;$('cropRight').value=o.cropRight||0;$('cropTop').value=o.cropTop||0;$('cropBottom').value=o.cropBottom||0;}$('imageAngleVal').textContent=`${o.angle||0}°`;}else if(o.type==='text'){$('textProps').classList.remove('hidden');if(fill){$('textValue').value=o.text;$('textSize').value=o.size;}}else{$('lineProps').classList.remove('hidden');if(fill){$('lineWidth').value=o.width;$('lineColor').value=o.color;}}}
  function updateSchedule(){const cams=state.objects.filter(o=>o.type==='camera');$('cameraSchedule').innerHTML=cams.length?`<table><tr><th>ID</th><th>Type</th><th>Location</th></tr>${cams.map(c=>`<tr><td>${esc(c.id)}</td><td>${esc(c.cameraType)}</td><td>${esc(c.location||'-')}</td></tr>`).join('')}</table>`:'No cameras added.';}
  $('imageInput').onchange=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=()=>{const im=new Image();im.onload=()=>{snapshot();const L=layoutMetrics(),scale=Math.min(1,L.mainW*.55/im.naturalWidth,L.mainH*.55/im.naturalHeight);const o={uid:uid(),type:'image',data:r.result,x:L.mainX+L.mainW/2,y:L.mainY+L.mainH/2,w:Math.max(80,im.naturalWidth*scale),h:Math.max(60,im.naturalHeight*scale),angle:0,cropLeft:0,cropRight:0,cropTop:0,cropBottom:0,aspectRatio:im.naturalWidth/im.naturalHeight,lockAspect:true};imageCache.set(r.result,im);state.objects.push(o);state.selected=o;updateProps();draw();};im.src=r.result;};r.readAsDataURL(f);e.target.value='';};
  function loadBgData(data){state.bgData=data||null;if(!data){state.bg=null;draw();return;}const im=new Image();im.onload=()=>{state.bg=im;draw();};im.src=data;}
  $('addPageBtn').onclick=()=>{syncCurrentPage();state.pages.push(newBlankPage());loadPage(state.pages.length-1);};
  $('pageSelect').onchange=e=>{syncCurrentPage();loadPage(+e.target.value||0);};
  $('deletePageBtn').onclick=()=>{if(state.pages.length<=1)return;if(!confirm('Delete current page?'))return;state.pages.splice(state.currentPage,1);loadPage(Math.max(0,state.currentPage-1));};
  $('newBtn').onclick=()=>{if(confirm('Start a new project?')){state.pages=[{paper:'A3',objects:[],bgData:null,meta:{client:'',project:'',site:'',drawingNo:'',preparedBy:'',date:new Date().toISOString().slice(0,10)}}];state.currentPage=0;state.clientId='';state.diagramId='';loadPage(0);refreshClients();}};
  $('saveClientBtn').onclick=()=>{try{refreshClients();if(!state.clientId)return alert('Select a client from the Client search list first.');const b=bridge();if(!b)return alert('Client mapping is available only when Diagram Maker is opened inside WipkoERP.');const data=projectData(),name=$('projectName').value||$('drawingNo').value||'CCTV Diagram';const rec=b.save(state.clientId,data,name,state.diagramId);state.diagramId=rec.id;refreshSavedDiagrams();$('savedDiagramSelect').value=rec.id;alert('Diagram saved to selected client.');}catch(err){alert(err.message||'Unable to save diagram to client.')}};
  $('loadClientDiagramBtn').onclick=()=>{try{const selectedId=$('savedDiagramSelect').value||state.diagramId||'';refreshClients();if(!state.clientId||!selectedId)return alert('Select a client and saved diagram.');const b=bridge();if(!b)return alert('Client mapping is available only when Diagram Maker is opened inside WipkoERP.');const d=b.load(state.clientId,selectedId);if(!d)return alert('Saved diagram not found.');state.diagramId=selectedId;loadProjectObject(d);refreshSavedDiagrams(selectedId);$('savedDiagramSelect').value=selectedId;}catch(err){alert(err.message||'Unable to load saved diagram.')}};
  function loadProjectObject(d){snapshot();if(Array.isArray(d.pages)&&d.pages.length){state.pages=clone(d.pages);state.currentPage=Math.min(+d.currentPage||0,state.pages.length-1);state.clientId=d.clientId||state.clientId||'';state.diagramId=d.diagramId||state.diagramId||'';loadPage(state.currentPage);}else{state.pages=[{paper:d.paper||'A3',objects:(d.objects||[]).filter(o=>o.type!=='cable'),bgData:d.bgData||null,meta:d.meta||{}}];state.currentPage=0;loadPage(0);}refreshClients();}
  $('pdfBtn').onclick=exportPdf;
  function exportPdf(){syncCurrentPage();const original=state.currentPage,selected=state.selected,imgs=[];for(let i=0;i<state.pages.length;i++){const d=state.pages[i];state.objects=clone(d.objects||[]);state.paper=d.paper||'A3';$('paperSize').value=state.paper;resizePaper(false);applyMeta(d.meta||{});state.bgData=d.bgData||null;state.bg=null;if(state.bgData){const im=new Image();im.src=state.bgData;state.bg=im;}state.selected=null;draw();imgs.push({src:canvas.toDataURL('image/png'),paper:state.paper});}loadPage(original);state.selected=selected;draw();const w=window.open('','_blank','width=1100,height=900');if(!w){alert('Popup blocked. Please allow popups to export PDF.');return}w.document.open();w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>CCTV Diagram PDF</title><style>@page{margin:0}body{margin:0;background:#ddd}.bar{position:sticky;top:0;background:#111827;padding:10px;text-align:right;z-index:5}.bar button{padding:9px 14px;border:0;border-radius:8px;background:#1769ff;color:#fff;font-weight:700}.p{background:#fff;margin:10px auto;page-break-after:always;break-after:page}.p:last-child{page-break-after:auto}.p img{display:block;width:100%;height:auto}@media print{body{background:#fff}.bar{display:none}.p{margin:0}}</style></head><body><div class="bar"><button onclick="window.print()">Print / Save PDF</button></div>'+imgs.map(x=>`<div class="p"><img src="${x.src}"></div>`).join('')+'</body></html>');w.document.close();w.focus();}
  function base64ToBytes(s){const bin=atob(s),a=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
  function safe(s){return String(s).trim().replace(/[^a-z0-9-_]+/gi,'-').replace(/^-|-$/g,'')||'file';}
  function download(blob,name){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);}
  window.addEventListener('keydown',e=>{if(e.key==='Delete')$('deleteBtn').click();if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='d'){e.preventDefault();duplicateSelected();}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo();}if((e.ctrlKey||e.metaKey)&&(e.key==='+'||e.key==='=')){e.preventDefault();zoomBy(ZOOM_STEP);}if((e.ctrlKey||e.metaKey)&&e.key==='-'){e.preventDefault();zoomBy(-ZOOM_STEP);}if((e.ctrlKey||e.metaKey)&&e.key==='0'){e.preventDefault();applyZoom(1);}});

  if(!$('drawingDate').value)$('drawingDate').value=new Date().toISOString().slice(0,10);
  state.pages=[capturePage()];state.currentPage=0;updatePageUI();refreshClients();resizePaper(false);applyZoom(1,false);draw();updateSchedule();syncToolButtons();
})();
