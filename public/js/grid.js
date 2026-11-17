// Grid tab (ported from LoRA Lens v5 — Strength Grid): contact sheet of local
// images grouped by matching generation settings, plus the LoRA strength grid.
// Images are read in the browser only; nothing is uploaded.
import { app, chooseFolder } from './app.js';
import { readImageFile, analyze, normalizeName } from './meta.js';
import { findByName, whenReady } from './loras.js';

const root = document.getElementById('tab-grid');
const byId=id=>document.getElementById('gr-'+id);
const records=[],knownFiles=new Set();let renderTimeout=0,busy=false;
const safe=(v,limit=140)=>String(v??'').slice(0,limit);
const lower=v=>String(v??'').toLowerCase();
const uniq=xs=>[...new Set(xs.filter(Boolean))];
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const fmt=v=>v===undefined||v===null||v===''?'—':String(v);
const html=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sortObject=x=>Array.isArray(x)?x.map(sortObject):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,sortObject(x[k])])):x;
const keyOf=o=>JSON.stringify(sortObject(o));
function shortLora(l){return l.name+(l.model!==null?' @'+l.model:'')+(l.clip!==null&&String(l.clip)!==String(l.model)?'/'+l.clip:'')}
function comparisonKey(r){const a=r.analysis;return keyOf({model:a.model,prompt:a.prompt,seed:a.stats.seed,steps:a.stats.steps,cfg:a.stats.cfg,sampler:a.stats.sampler,scheduler:a.stats.scheduler,denoise:a.stats.denoise,width:r.width||'',height:r.height||''})}
function groupKey(r,mode){if(mode==='compare')return r.analysis.detected?comparisonKey(r):'missing-metadata|'+r.file.name+'|'+r.file.lastModified;if(mode==='lora')return keyOf([r.analysis.model,r.analysis.loras.map(shortLora).sort()]);if(mode==='model')return r.analysis.model;return 'all'}
function groupTitle(list,mode,index){if(mode==='bylora')return list.loraName||'No LoRA';const a=list[0].analysis;if(mode==='compare')return a.model==='Unknown model'?'Matching generation settings':a.model;if(mode==='lora')return `${a.model} · ${a.loras.map(shortLora).join(', ')||'No LoRA'}`;if(mode==='model')return a.model;return 'All images'}
function groupSub(list,mode){if(mode==='bylora')return byLoraSub(list);const r=list[0],a=r.analysis;if(mode==='compare'){return [a.stats.seed&&`Seed ${a.stats.seed}`,a.stats.steps&&`${a.stats.steps} steps`,a.stats.cfg&&`CFG ${a.stats.cfg}`,a.stats.sampler&&a.stats.sampler,r.width&&`${r.width}×${r.height}`,a.prompt&&`Prompt: ${a.prompt.slice(0,110)}${a.prompt.length>110?'…':''}`].filter(Boolean).join(' · ')||'No comparable generation parameters detected'}if(mode==='lora')return 'All images in this section share the same base model and LoRA set';if(mode==='model')return 'All images use this model';return 'Unfiltered library'}
function scheduleRender(){clearTimeout(renderTimeout);renderTimeout=setTimeout(render,70)}
function filteredRecords(){const q=lower(byId('search').value).trim();return records.filter(r=>!q||[r.file.name,r.analysis.model,r.analysis.prompt,r.analysis.loras.map(shortLora).join(' '),Object.values(r.analysis.stats).join(' ')].some(v=>lower(v).includes(q)))}
/* By LoRA: every image that uses a LoRA is put in that LoRA's group, whatever the base model or settings.
   An image with several LoRAs appears in each of their groups. */
const loraKey=n=>normalizeName(n).toLowerCase();
function byLoraSub(list){
 const k=list.loraKey,bases=uniq(list.map(r=>r.analysis.model)),strengths=list.map(r=>{const l=r.analysis.loras.find(x=>loraKey(x.name)===k);return l?sval(l.model):null}).filter(v=>v!==null);
 if(!k)return 'Images with no LoRA in their metadata';
 return [`${bases.length} base model${bases.length===1?'':'s'}: ${bases.slice(0,4).join(', ')}${bases.length>4?' …':''}`,strengths.length?(Math.min(...strengths)===Math.max(...strengths)?`strength ${strengths[0]}`:`strength ${Math.min(...strengths)} → ${Math.max(...strengths)}`):''].filter(Boolean).join(' · ');
}
function loraStrength(r,k){const l=r.analysis.loras.find(x=>loraKey(x.name)===k);return l?sval(l.model)??0:0}
function buildGroups(){const mode=byId('groupMode').value,match=filteredRecords();const map=new Map();for(const r of match){
  if(mode==='bylora'){
   const names=new Map(r.analysis.loras.map(l=>[loraKey(l.name),l.name]));
   if(!names.size)names.set('',null);
   for(const [k,name] of names){if(!map.has('L|'+k)){const g=[];g.loraKey=k;g.loraName=name;map.set('L|'+k,g)}map.get('L|'+k).push(r)}
   continue;
  }
  const key=groupKey(r,mode);if(!map.has(key))map.set(key,[]);map.get(key).push(r)}let groups=[...map.values()].filter(l=>!byId('multiOnly').checked||l.length>=2);const sort=byId('sort').value;if(sort==='count')groups.sort((a,b)=>b.length-a.length||groupTitle(a,mode).localeCompare(groupTitle(b,mode)));if(sort==='name')groups.sort((a,b)=>groupTitle(a,mode).localeCompare(groupTitle(b,mode)));if(sort==='newest')groups.sort((a,b)=>Math.max(...b.map(r=>r.file.lastModified))-Math.max(...a.map(r=>r.file.lastModified)));if(mode==='bylora'){groups.forEach(g=>g.sort((a,b)=>a.analysis.model.localeCompare(b.analysis.model)||loraStrength(a,g.loraKey)-loraStrength(b,g.loraKey)||a.file.name.localeCompare(b.file.name)));groups.sort((a,b)=>(a.loraKey===''?1:0)-(b.loraKey===''?1:0));return groups}
 groups.forEach(g=>g.sort((a,b)=>a.analysis.loras.map(l=>l.name).join().localeCompare(b.analysis.loras.map(l=>l.name).join())||a.file.name.localeCompare(b.file.name)));return groups}
function applyColumns(){
 const slider=byId('columns'),desired=Number(slider.value),area=byId('results');
 const width=area.clientWidth||window.innerWidth;
 const responsiveMax=Math.max(2,Math.floor(Math.max(200,width-22)/102));
 const actual=Math.max(2,Math.min(desired,responsiveMax));
 area.style.setProperty('--cols',actual);
 byId('columnsCount').textContent=actual===desired?String(desired):`${actual} / ${desired}`;
 slider.title=`${actual} images per row at this window width (up to ${desired})`;
 const indicator=byId('layoutIndicator');if(indicator)indicator.textContent=`${byId('viewMode').value==='wall'?'GRID':'GROUPS'} · ${actual} ACROSS`;
 sizeStrengthGrids();
}
/* ---------- LoRA strength grid ---------- */
const sval=v=>v===null||v===undefined||v===''?null:num(v);
const loraOf=(r,n)=>r.analysis.loras.find(l=>l.name===n)||null;
const strengthSig=l=>l?`${sval(l.model)}|${sval(l.clip)}`:'off';
const strengthText=l=>{if(!l)return 'OFF';const m=l.model===null?'?':String(l.model);return l.clip!==null&&String(l.clip)!==String(l.model)?`${m} / clip ${l.clip}`:m};
function cmpStrength(a,b){if(!a||!b)return (a?1:0)-(b?1:0);const x=sval(a.model),y=sval(b.model);if(x!==y){if(x===null)return 1;if(y===null)return -1;return x-y}return (sval(a.clip)??0)-(sval(b.clip)??0)}
function baseSettings(r,ignoreSeed){const a=r.analysis;return {model:a.model,prompt:a.prompt,seed:ignoreSeed?'':a.stats.seed,steps:a.stats.steps,cfg:a.stats.cfg,sampler:a.stats.sampler,scheduler:a.stats.scheduler,denoise:a.stats.denoise,width:r.width||'',height:r.height||''}}
function strengthSets(){
 const ignoreSeed=byId('ignoreSeed').checked,includeOff=byId('includeOff').checked,map=new Map(),offMap=new Map();
 for(const r of filteredRecords()){
  if(!r.analysis.detected)continue;
  const base=baseSettings(r,ignoreSeed);
  if(!r.analysis.loras.length){const k=keyOf(base);if(!offMap.has(k))offMap.set(k,[]);offMap.get(k).push(r);continue}
  const names=uniq(r.analysis.loras.map(l=>l.name)).sort(),key=keyOf({...base,loras:names});
  if(!map.has(key))map.set(key,{names,base:keyOf(base),images:[]});map.get(key).images.push(r);
 }
 const sets=[];
 for(const s of map.values()){
  // Which LoRAs actually change strength inside this set? Only those get a big label.
  s.varying=s.names.filter(n=>new Set(s.images.map(r=>strengthSig(loraOf(r,n)))).size>1);
  if(s.images.length<2||!s.varying.length)continue;
  s.fixed=s.names.filter(n=>!s.varying.includes(n));
  s.images.sort((a,b)=>{for(const n of s.varying){const d=cmpStrength(loraOf(a,n),loraOf(b,n));if(d)return d}return String(a.analysis.stats.seed).localeCompare(String(b.analysis.stats.seed),undefined,{numeric:true})||a.file.name.localeCompare(b.file.name)});
  s.off=includeOff?(offMap.get(s.base)||[]):[];
  s.all=[...s.off,...s.images];
  sets.push(s);
 }
 return sets.sort((a,b)=>b.all.length-a.all.length||a.varying.join().localeCompare(b.varying.join()));
}
function strengthLines(r,set){
 if(!r.analysis.loras.length)return {main:'OFF',sub:'no LoRA',off:true};
 const many=set.varying.length>1,main=many?set.varying.map(n=>`${n}: ${strengthText(loraOf(r,n))}`).join('\n'):strengthText(loraOf(r,set.varying[0]));
 const seeds=new Set(set.all.map(x=>x.analysis.stats.seed));
 return {main,sub:seeds.size>1?`seed ${r.analysis.stats.seed}`:'',off:false};
}
function strengthRange(set){const vals=set.images.map(r=>sval((loraOf(r,set.varying[0])||{}).model)).filter(v=>v!==null);return vals.length?`${Math.min(...vals)} → ${Math.max(...vals)}`:''}
// Per-set view state survives re-renders (search, toggles) so the user's choices stick.
const setUI=new Map();let activeUI=null,lastStrengthMode='grid';
const el=(tag,cls,text)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e};
const setId=set=>set.base+'|'+set.names.join(',');
const ratioOf=set=>{const f=set.images[0];return f.width&&f.height?f.width/f.height:1};
function uiFor(set){
 const id=setId(set);if(!setUI.has(id))setUI.set(id,{mode:lastStrengthMode,cols:0,fit:true,zoom:1,a:0,b:set.all.length-1,cur:0,wipe:false,timer:0,speed:700});
 const u=setUI.get(id),n=set.all.length;u.set=set;u.a=Math.min(u.a,n-1);u.b=Math.min(u.b,n-1);u.cur=Math.min(u.cur,n-1);return u;
}
function stopPlay(ui){if(ui.timer){clearInterval(ui.timer);ui.timer=0}}
function sizeStrengthGrids(){
 for(const g of document.querySelectorAll('#results .sgrid')){
  const ui=g._ui;if(!ui)continue;const n=ui.set.all.length,avail=Math.max(200,(g.parentElement?.clientWidth||innerWidth)-20),ratio=ratioOf(ui.set);
  const maxFit=Math.max(1,Math.floor(avail/90));let c=Math.min(ui.cols||Math.ceil(Math.sqrt(n)),maxFit,n);
  g.style.setProperty('--scols',c);
  if(ui.fit){ // shrink the grid so every image is visible at once without scrolling
   const rows=Math.ceil(n/c),availH=innerHeight-150,tileH=Math.max(70,availH/rows-30),tileW=tileH*ratio;
   g.style.maxWidth=Math.max(c*90,Math.round(c*(tileW+6)+20))+'px';
  } else g.style.maxWidth='none';
 }
}
function strengthLabelEl(r,set,i,cls='slabel'){
 const L=strengthLines(r,set),d=el('div',cls+(L.off?' off':''));
 const b=el('b');b.innerHTML=html(L.main).replace(/\n/g,'<br>');d.append(b);
 d.append(el('span','',[L.sub,i!==undefined?'#'+(i+1):''].filter(Boolean).join(' · ')));return d;
}
function zframe(r,ratio,extra){const z=el('div','zwrap'+(extra?' '+extra:''));z.style.aspectRatio=String(ratio);if(r){const img=el('img');img.src=r.url;img.alt=r.file.name;img.draggable=false;z.append(img)}return z}
function chipText(r,set){return strengthLines(r,set).main.replace(/\n/g,' · ')}
function chipRow(ui,label,pick,onPick){
 const row=el('div','chiprow');if(label)row.append(el('b','',label));
 ui.set.all.forEach((r,i)=>{const c=el('button',(r.analysis.loras.length?'':'offchip')+(i===pick?' on':''),chipText(r,ui.set));c.type='button';c.title=r.file.name;c.onclick=()=>{activeUI=ui;onPick(i)};row.append(c)});
 return row;
}
function segment(options,current,onPick){const s=el('div','seg');for(const [v,lab,tip] of options){const b=el('button',v===current?'on':'',lab);b.type='button';if(tip)b.title=tip;b.onclick=()=>onPick(v);s.append(b)}return s}
function drawSet(ui){
 const set=ui.set,n=set.all.length,ratio=ratioOf(set),wrap=ui.wrap,keepY=scrollY;stopPlay(ui);
 if(wrap.offsetHeight)wrap.style.minHeight=wrap.offsetHeight+'px'; // avoid the page jumping while we rebuild
 requestAnimationFrame(()=>{wrap.style.minHeight='';if(Math.abs(scrollY-keepY)>2)scrollTo(0,keepY)});
 wrap.replaceChildren();
 ui.root.classList.toggle('zoom-on',ui.zoom>1);ui.root.style.setProperty('--z',ui.zoom);
 // ---- toolbar
 const tb=el('div','stoolbar');
 tb.append(segment([['grid','▦ Grid','See every strength at once'],['flip','⇆ Flip through','One big image — step through strengths'],['ab','◫ Side by side','Compare two strengths']],ui.mode,m=>{ui.mode=lastStrengthMode=m;activeUI=ui;drawSet(ui)}));
 const zg=el('div','tgroup');zg.append(el('span','','Zoom'),segment([[1,'Off'],[2,'2×'],[3,'3×'],[5,'5×']],ui.zoom,z=>{ui.zoom=z;drawSet(ui)}));tb.append(zg);
 let hint='';
 if(ui.mode==='grid'){
  const cg=el('div','tgroup');cg.append(el('span','','Columns'));
  const auto=Math.ceil(Math.sqrt(n)),cur=ui.cols||auto;
  cg.append(segment([['-','−','Fewer columns (bigger images)'],['auto',ui.cols?'Auto':`Auto (${auto})`],['+','+','More columns']],ui.cols?'':'auto',v=>{ui.cols=v==='auto'?0:Math.max(1,Math.min(n,cur+(v==='+'?1:-1)));drawSet(ui)}));
  if(ui.cols)cg.append(el('b','',String(ui.cols)));
  const fit=el('label','check');const cb=el('input');cb.type='checkbox';cb.checked=ui.fit;cb.onchange=()=>{ui.fit=cb.checked;sizeStrengthGrids()};fit.append(cb,document.createTextNode(' Fit whole grid on screen'));cg.append(fit);
  tb.append(cg);hint='Click an image to open it · with Zoom on, hover to magnify the same spot on every image';
 } else if(ui.mode==='flip'){
  const pg=el('div','tgroup');const play=el('button','btn tiny',ui.timer?'❚❚ Pause':'▶ Play');play.type='button';
  play.onclick=()=>{if(ui.timer){stopPlay(ui);play.textContent='▶ Play'}else{ui.timer=setInterval(()=>step(ui,1),ui.speed);play.textContent='❚❚ Pause'}};
  const sp=el('select');for(const [v,t] of [[1200,'Slow'],[700,'Normal'],[350,'Fast']]){const o=el('option','',t);o.value=v;o.selected=v===ui.speed;sp.append(o)}
  sp.style.cssText='height:28px;border-radius:7px;background:#0d1520;color:var(--text);border:1px solid #344356';sp.onchange=()=>{ui.speed=Number(sp.value);if(ui.timer){stopPlay(ui);ui.timer=setInterval(()=>step(ui,1),ui.speed)}};
  ui.playBtn=play;pg.append(play,sp);tb.append(pg);
  hint='';
 } else {
  const ag=el('div','tgroup');
  ag.append(segment([[false,'Two panels'],[true,'Wipe slider','Drag across the image to reveal A vs B']],ui.wipe,v=>{ui.wipe=v;drawSet(ui)}));
  const sw=el('button','btn tiny','⇄ Swap A/B');sw.type='button';sw.onclick=()=>{[ui.a,ui.b]=[ui.b,ui.a];drawSet(ui)};ag.append(sw);tb.append(ag);
  hint='';
 }
 const keys={grid:'',flip:'<kbd>←</kbd> <kbd>→</kbd> or mouse wheel to step · <kbd>Space</kbd> play',ab:'<kbd>←</kbd> <kbd>→</kbd> change B · <kbd>Shift</kbd>+<kbd>←</kbd> <kbd>→</kbd> change A'}[ui.mode];
 const h=el('div','shint');h.innerHTML=keys||html(hint);tb.append(h);wrap.append(tb);
 // ---- body
 if(ui.mode==='grid'){
  const grid=el('div','sgrid');grid._ui=ui;
  set.all.forEach((r,i)=>{const t=el('div','stile');t.title=`${r.file.name}\n${r.analysis.loras.map(shortLora).join(' · ')||'No LoRA'}`;t.append(strengthLabelEl(r,set,i),zframe(r,ratio));t.onclick=()=>showDetail(r,set.all);grid.append(t)});
  wrap.append(grid);sizeStrengthGrids();
 } else if(ui.mode==='flip'){
  const st=el('div','flipstage'),lab=el('div','bigl'),z=zframe(set.all[ui.cur],ratio);z.style.maxWidth=`calc(72vh * ${ratio})`;
  st.append(lab,z);wrap.append(st);
  z.addEventListener('wheel',e=>{e.preventDefault();const now=Date.now();if(now-(ui.wheel||0)<120)return;ui.wheel=now;step(ui,e.deltaY>0?1:-1)},{passive:false});
  z.addEventListener('click',()=>showDetail(set.all[ui.cur],set.all));
  const chips=chipRow(ui,'',ui.cur,i=>{ui.cur=i;updateFlip(ui)});wrap.append(chips);
  ui.flip={lab,img:z.querySelector('img'),chips};updateFlip(ui);
  for(const r of set.all){const p=new Image();p.src=r.url} // preload so flipping is instant
 } else if(!ui.wipe){
  const st=el('div','abstage');
  for(const [key,name] of [['a','A'],['b','B']]){const r=set.all[ui[key]],p=el('div','abpane'),lab=el('div','bigl');const L=strengthLines(r,set);lab.className='bigl'+(L.off?' off':'');lab.innerHTML=`${name}: ${html(chipText(r,set))}<small>${html(r.file.name)}</small>`;const z=zframe(r,ratio);z.style.maxWidth=`calc(68vh * ${ratio})`;z.onclick=()=>showDetail(r,set.all);p.append(lab,z);st.append(p)}
  wrap.append(st,chipRow(ui,'A',ui.a,i=>{ui.a=i;drawSet(ui)}),chipRow(ui,'B',ui.b,i=>{ui.b=i;drawSet(ui)}));
 } else {
  const st=el('div','wipestage'),A=set.all[ui.a],B=set.all[ui.b],z=zframe(null,ratio,'wipe');z.style.maxWidth=`calc(74vh * ${ratio})`;
  const ia=el('img','a');ia.src=A.url;ia.draggable=false;const ib=el('img','b');ib.src=B.url;ib.draggable=false;
  z.append(ia,ib,el('div','wipeline'),el('span','wlab a','A: '+chipText(A,set)),el('span','wlab b','B: '+chipText(B,set)));
  z.style.setProperty('--wx',(ui.wx??50)+'%');
  const move=e=>{const rc=z.getBoundingClientRect(),x=((e.touches?e.touches[0].clientX:e.clientX)-rc.left)/rc.width*100;ui.wx=Math.max(0,Math.min(100,x));z.style.setProperty('--wx',ui.wx+'%')};
  z.addEventListener('mousemove',move);z.addEventListener('touchmove',e=>{e.preventDefault();move(e)},{passive:false});
  st.append(z);wrap.append(st,chipRow(ui,'A',ui.a,i=>{ui.a=i;drawSet(ui)}),chipRow(ui,'B',ui.b,i=>{ui.b=i;drawSet(ui)}));
 }
}
function updateFlip(ui){
 const r=ui.set.all[ui.cur],L=strengthLines(r,ui.set),f=ui.flip;if(!f)return;
 f.img.src=r.url;f.img.alt=r.file.name;f.lab.className='bigl'+(L.off?' off':'');
 f.lab.innerHTML=`${html(chipText(r,ui.set))}<small>${ui.cur+1} of ${ui.set.all.length}${L.sub?' · '+html(L.sub):''} · ${html(r.file.name)}</small>`;
 [...f.chips.children].forEach((c,i)=>c.classList.toggle('on',i===ui.cur));
}
function step(ui,dir,shift){
 const n=ui.set.all.length;
 if(ui.mode==='flip'){ui.cur=(ui.cur+dir+n)%n;updateFlip(ui);return true}
 if(ui.mode==='ab'){if(shift)ui.a=(ui.a+dir+n)%n;else ui.b=(ui.b+dir+n)%n;drawSet(ui);return true}
 return false;
}
function setActive(ui){activeUI=ui;document.querySelectorAll('#results .sset').forEach(s=>s.classList.toggle('active',s===ui.root))}
function renderStrength(result){
 for(const u of setUI.values())stopPlay(u);
 const sets=strengthSets();
 byId('stats').innerHTML=`<span><b>${records.length}</b> images loaded</span><span><b>${sets.length}</b> strength set${sets.length===1?'':'s'} found</span><span><b>${sets.reduce((n,s)=>n+s.all.length,0)}</b> images in strength grids</span>`;
 const ind=byId('layoutIndicator');if(ind)ind.textContent='STRENGTH · AUTO GRID';
 if(!sets.length){result.innerHTML='<div class="empty"><div class="big">▦</div><h3>No LoRA strength sets found</h3><p>A set needs 2+ images with the same model, prompt, seed, steps, CFG, sampler and size, using the same LoRA at different strengths.<br>Try "Ignore seed" if your seeds were randomized, or clear the search box.</p></div>';return}
 result.replaceChildren();
 sets.forEach((set,idx)=>{
  const first=set.images[0],a=first.analysis,n=set.all.length,ui=uiFor(set);
  const s=document.createElement('section');s.className='sset';ui.root=s;
  s.addEventListener('pointerdown',()=>setActive(ui));s.addEventListener('mouseenter',()=>{if(!activeUI||!activeUI.root?.isConnected)setActive(ui)});
  // Synced zoom: hovering any image magnifies the same spot on every image in this set.
  s.addEventListener('mousemove',e=>{if(ui.zoom<=1)return;const z=e.target.closest?.('.zwrap');if(!z||!s.contains(z)){s.classList.remove('zooming');return}const rc=z.getBoundingClientRect();s.style.setProperty('--zx',((e.clientX-rc.left)/rc.width*100)+'%');s.style.setProperty('--zy',((e.clientY-rc.top)/rc.height*100)+'%');s.classList.add('zooming')});
  s.addEventListener('mouseleave',()=>s.classList.remove('zooming'));
  const h=document.createElement('div');h.className='grouphead';
  const label=document.createElement('div');
  const details=[a.model,!byId('ignoreSeed').checked&&a.stats.seed&&`Seed ${a.stats.seed}`,a.stats.steps&&`${a.stats.steps} steps`,a.stats.cfg&&`CFG ${a.stats.cfg}`,a.stats.sampler,first.width&&`${first.width}×${first.height}`,set.fixed.length&&`Fixed: ${set.fixed.map(nm=>shortLora(loraOf(first,nm))).join(', ')}`,a.prompt&&`Prompt: ${a.prompt.slice(0,140)}${a.prompt.length>140?'…':''}`].filter(Boolean).join(' · ');
  label.innerHTML=`<div class="groupname">${html(set.varying.join(' + '))} <span class="chip">${n} images</span>${strengthRange(set)?`<span class="chip tone">strength ${html(strengthRange(set))}</span>`:''}</div><div class="groupdetails" title="${html(details)}">${html(details)}</div>`;
  h.append(label);
  const buttons=document.createElement('div');buttons.className='groupbuttons';
  const exportBtn=document.createElement('button');exportBtn.className='btn tiny';exportBtn.textContent='↓ Export strength grid';exportBtn.addEventListener('click',()=>exportStrengthSet(set,idx));buttons.append(exportBtn);h.append(buttons);s.append(h);
  ui.wrap=el('div');s.append(ui.wrap);result.append(s);drawSet(ui);
 });
}
// Wait for an image via onload (unlike decode(), this also completes when the tab is in the background).
const loadImg=img=>img.complete&&img.naturalWidth?Promise.resolve():new Promise((res,rej)=>{img.onload=res;img.onerror=rej});
async function exportStrengthSet(set,index){
 const imgs=set.all,n=imgs.length,cols=Math.ceil(Math.sqrt(n)),rows=Math.ceil(n/cols),first=set.images[0],a=first.analysis;
 const cell=n>36?320:n>16?400:512,ar=first.width&&first.height?first.height/first.width:1,cellH=Math.round(cell*ar),gap=6,headH=78;
 const cvs=document.createElement('canvas');cvs.width=cols*(cell+gap)+gap;cvs.height=headH+rows*(cellH+gap)+gap;
 const ctx=cvs.getContext('2d');if(!ctx)return;ctx.fillStyle='#101722';ctx.fillRect(0,0,cvs.width,cvs.height);
 ctx.fillStyle='#fff12b';ctx.font='900 26px system-ui';ctx.fillText(`${set.varying.join(' + ')} · strength ${strengthRange(set)}`,gap+6,34,cvs.width-24);
 ctx.fillStyle='#b9cadb';ctx.font='14px system-ui';
 ctx.fillText([a.model,!byId('ignoreSeed').checked&&a.stats.seed&&`Seed ${a.stats.seed}`,a.stats.steps&&`${a.stats.steps} steps`,a.stats.cfg&&`CFG ${a.stats.cfg}`,a.stats.sampler,set.fixed.length&&`Fixed: ${set.fixed.map(nm=>shortLora(loraOf(first,nm))).join(', ')}`].filter(Boolean).join(' · '),gap+6,56,cvs.width-24);
 ctx.fillStyle='#7f93a8';ctx.font='12px system-ui';ctx.fillText(a.prompt?`Prompt: ${a.prompt.slice(0,400)}`:'',gap+6,72,cvs.width-24);
 const fontPx=Math.round(cell/9);
 for(let i=0;i<n;i++){
  const r=imgs[i],x=gap+(i%cols)*(cell+gap),y=headH+Math.floor(i/cols)*(cellH+gap);
  ctx.fillStyle='#1b2633';ctx.fillRect(x,y,cell,cellH);
  const img=new Image;img.src=r.url;
  try{await loadImg(img);const s=Math.min(cell/img.naturalWidth,cellH/img.naturalHeight),w=img.naturalWidth*s,h=img.naturalHeight*s;ctx.drawImage(img,x+(cell-w)/2,y+(cellH-h)/2,w,h)}catch{}
  const L=strengthLines(r,set),lines=L.main.split('\n'),subPx=Math.round(fontPx*.5),band=lines.length*fontPx*1.1+(L.sub?subPx+6:0)+22;
  const grad=ctx.createLinearGradient(0,y+cellH-band,0,y+cellH);grad.addColorStop(0,'#00000000');grad.addColorStop(.4,'#000000aa');grad.addColorStop(1,'#000000e0');
  ctx.fillStyle=grad;ctx.fillRect(x,y+cellH-band,cell,band);
  ctx.save();ctx.textBaseline='bottom';ctx.strokeStyle='#000';ctx.lineWidth=Math.max(3,fontPx/8);
  let yy=y+cellH-8;
  if(L.sub){ctx.font=`800 ${subPx}px system-ui`;ctx.fillStyle='#fff4a8';ctx.strokeText(L.sub,x+10,yy,cell-20);ctx.fillText(L.sub,x+10,yy,cell-20);yy-=subPx+4}
  ctx.font=`900 ${fontPx}px system-ui`;ctx.fillStyle=L.off?'#ff9d6b':'#fff12b';
  for(let j=lines.length-1;j>=0;j--){ctx.strokeText(lines[j],x+10,yy,cell-20);ctx.fillText(lines[j],x+10,yy,cell-20);yy-=fontPx*1.1}
  ctx.restore();
 }
 cvs.toBlob(blob=>{if(!blob)return;const link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=`lora-strength-${set.varying.join('+').replace(/[^\w+.-]+/g,'_').slice(0,80)}-${index+1}.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)},'image/png');
}
function createTile(r,groupNumber,tagSet,list){
 let tile=document.createElement('article');tile.className='tile';tile.title='Click to enlarge and inspect metadata';
 let frame=document.createElement('div');frame.className='frame';let img=document.createElement('img');img.src=r.url;img.alt=r.file.name;img.loading='lazy';frame.append(img);
 // LoRA names live in their own bar BELOW the image, so the image is never covered.
 // The bar stretches to the tallest one in the row, keeping the captions in a row aligned.
 const bar=document.createElement('div');bar.className='namebar';
 if(r.analysis.loras.length){for(const l of r.analysis.loras){
  const line=document.createElement('div');line.className='nb-line';line.title=shortLora(l);
  const nm=document.createElement('span');nm.className='nb-name';
  // Allow line breaks after _ and - so long names wrap at word-like boundaries instead of mid-word.
  for(const part of l.name.split(/(?<=[_\-])/))nm.append(part,document.createElement('wbr'));
  line.append(nm);
  if(l.model!==null){const st=document.createElement('span');st.className='nb-str';st.textContent=strengthText(l);line.append(st)}
  bar.append(line);
 }} else {bar.classList.add('none');bar.textContent=r.analysis.detected?'No LoRA':'LoRA unknown'}
 if(!r.analysis.detected){let warning=document.createElement('span');warning.className='flag';warning.textContent='No metadata';frame.append(warning)}
 frame.append(pickButton(r));tile.dataset.key=r.key;paintTier(tile,r);
 tile.append(frame,bar);
 let cap=document.createElement('div');cap.className='caption';
 cap.innerHTML=`<div class="model" title="${html(r.analysis.model)}">${html(r.analysis.model)}</div><div class="loras" title="${html(r.analysis.loras.map(shortLora).join(' · '))}">${html(r.analysis.loras.map(shortLora).join(' · ')||'No LoRA detected')}</div>${tagSet?`<div class="settag"><span>Set ${groupNumber+1}</span> ${html((r.analysis.stats.seed??'')!==''?'Seed '+r.analysis.stats.seed:'')}</div>`:''}<div class="filename" title="${html(r.file.name)}">${html(r.file.name)}</div>`;
 tile.append(cap);tile.addEventListener('click',()=>{if(byId('clickPick').checked){togglePick(r);return}showDetail(r,list)});return tile;
}
/* ---------- Picks and finalists ----------
   Tier 1 = picked (♥), tier 2 = finalist (★, always also picked). Tiers are remembered per file
   (name + size + date) in this browser, so re-adding the same images restores your choices. */
const TIER_STORE='ls-grid-tiers';
const tiers=new Map();
try{for(const [k,v] of Object.entries(JSON.parse(localStorage.getItem(TIER_STORE)||'{}')))if(v===1||v===2)tiers.set(k,v)}catch{/* storage blocked */}
let scope='all';
const cubeUI={cols:0};
function tierKey(f){return [f.name,f.size,f.lastModified].join('|')}
const tierOf=r=>tiers.get(r.key)||0;
function saveTiers(){try{localStorage.setItem(TIER_STORE,JSON.stringify(Object.fromEntries(tiers)))}catch{/* storage blocked */}}
function paintTier(node,r){const t=tierOf(r);node.classList.toggle('picked',t>=1);node.classList.toggle('final',t===2);const b=node.querySelector('.pickbtn');if(b){b.classList.toggle('on',t>=1);b.title=t?'Remove from picks':'Pick this image'}}
function pickButton(r){const b=document.createElement('button');b.type='button';b.className='pickbtn';b.textContent='♥';b.setAttribute('aria-label','Pick this image');b.addEventListener('click',e=>{e.stopPropagation();togglePick(r)});return b}
function setTier(r,t){
 const before=tierOf(r);
 if(t>0)tiers.set(r.key,t);else tiers.delete(r.key);saveTiers();
 for(const n of document.querySelectorAll(`#tab-grid [data-key="${CSS.escape(r.key)}"]`))paintTier(n,r);
 if(currentDetail===r)paintModalTier();
 updatePickbar();
 if(before===0&&t>0&&scope==='all'&&records.filter(x=>tierOf(x)>=1).length===1)app.toast('Picked · open ♥ Picks to see your picks as a cube grid');
 if(scope!=='all')scheduleRender();
}
function togglePick(r){setTier(r,tierOf(r)?0:1)}
function toggleFinal(r){setTier(r,tierOf(r)===2?1:2)}
function scopeList(){const min=scope==='finals'?2:1;return filteredRecords().filter(r=>tierOf(r)>=min)}
function updatePickbar(){
 const picks=records.filter(r=>tierOf(r)>=1).length,finals=records.filter(r=>tierOf(r)===2).length;
 byId('countAll').textContent=records.length;byId('countPicks').textContent=picks;byId('countFinals').textContent=finals;
 for(const b of byId('scope').querySelectorAll('button'))b.classList.toggle('on',b.dataset.scope===scope);
 byId('pickActions').hidden=scope==='all';
 byId('pickHint').textContent=scope==='all'
  ?(picks?`${picks} picked${finals?` · ${finals} finalist${finals===1?'':'s'}`:''}. Open ♥ Picks to see them as one cube grid.`:'Click ♥ on any image to pick it. Your picks are shown together as one tight cube grid.')
  :scope==='picks'?'Click ★ on an image to promote it to a finalist. ✕ removes it from your picks.':'Your finalists. ✕ sends an image back to Picks.';
 byId('cubeClear').textContent=scope==='finals'?'Clear finalists':'Clear picks';
 root.classList.toggle('cube-mode',scope!=='all');
}
function setScope(s){scope=s;cubeUI.cols=0;updatePickbar();render();window.scrollTo(0,byId('pickbar').getBoundingClientRect().top+scrollY-62);sizeCube()}
function cubeRatio(list){
 // Most common aspect ratio, so same-size generations tile with no gaps.
 const counts=new Map();for(const r of list){if(!r.width||!r.height)continue;const k=(r.width/r.height).toFixed(3);counts.set(k,(counts.get(k)||0)+1)}
 let best=1,n=0;for(const [k,c] of counts)if(c>n){n=c;best=Number(k)}return best;
}
function cubeCols(n){return Math.max(1,Math.min(n,cubeUI.cols||Math.ceil(Math.sqrt(n))))}
function sizeCube(){
 const cube=document.querySelector('#gr-results .cube');if(!cube)return;
 const n=cube.children.length,cols=cubeCols(n),rows=Math.ceil(n/cols),ratio=Number(cube.dataset.ratio)||1;
 cube.style.setProperty('--cc',cols);
 // Fit: shrink the cube so every row is visible below the sticky header at once.
 // Measured as if the pick bar sits right under the sticky header (where setScope scrolls it).
 if(byId('cubeFit').checked){const top=Math.min(innerHeight*0.6,62+cube.getBoundingClientRect().top-byId('pickbar').getBoundingClientRect().top),availH=Math.max(200,innerHeight-top-12);cube.style.maxWidth=Math.max(cols*60,Math.floor(availH/rows*ratio*cols))+'px';
  // Borders and rounding can still leave it a little tall: measure once and shrink to fit.
  const h=cube.getBoundingClientRect().height;if(h>availH)cube.style.maxWidth=Math.max(cols*60,Math.floor(parseFloat(cube.style.maxWidth)*availH/h))+'px'}
 else cube.style.maxWidth='none';
 byId('cubeAuto').textContent=cubeUI.cols?'Auto':`Auto (${cols})`;
}
function renderCube(result){
 const list=scopeList(),label=scope==='finals'?'finalists':'picks';
 byId('stats').innerHTML=`<span><b>${list.length}</b> ${label} shown</span><span><b>${records.length}</b> images loaded</span>`;
 const ind=byId('layoutIndicator');if(ind)ind.textContent=`CUBE · ${list.length?cubeCols(list.length):0} ACROSS`;
 if(!list.length){result.className='layout-cube';result.innerHTML=scope==='finals'
  ?'<div class="empty"><div class="big">★</div><h3>No finalists yet</h3><p>Open ♥ Picks and click ★ on the images you want to keep as finalists.</p></div>'
  :'<div class="empty"><div class="big">♥</div><h3>No picks yet</h3><p>Go back to All images and click ♥ on the images you like (or turn on “Click an image to pick it”).</p></div>';return}
 result.className='layout-cube';result.replaceChildren();
 const cube=el('div','cube');cube.dataset.ratio=cubeRatio(list);cube.style.setProperty('--ar',cube.dataset.ratio);
 for(const r of list){
  const t=el('div','ctile');t.dataset.key=r.key;t.title=`${r.file.name}\n${r.analysis.loras.map(shortLora).join(' · ')||'No LoRA'}`;
  const img=el('img');img.src=r.url;img.alt=r.file.name;img.draggable=false;t.append(img);
  const btns=el('div','cbtns');
  if(scope==='picks'){const s=el('button','cstar','★');s.type='button';s.title='Finalist (toggle)';s.onclick=e=>{e.stopPropagation();toggleFinal(r)};btns.append(s)}
  const x=el('button','cx','✕');x.type='button';x.title=scope==='finals'?'Remove from finalists':'Remove from picks';x.onclick=e=>{e.stopPropagation();scope==='finals'?setTier(r,1):setTier(r,0)};btns.append(x);
  t.append(btns);paintTier(t,r);t.addEventListener('click',()=>{if(byId('clickPick').checked&&scope==='picks'){toggleFinal(r);return}showDetail(r,list)});cube.append(t);
 }
 result.append(cube);sizeCube(); // synchronous: rAF does not run while the window is in the background
}
async function exportCube(){
 const list=scopeList();if(!list.length)return;
 const cols=cubeCols(list.length),rows=Math.ceil(list.length/cols),ratio=cubeRatio(list);
 let cellW=Math.min(768,list[0].width||512);cellW=Math.max(64,Math.min(cellW,Math.floor(16000/cols)));let cellH=Math.round(cellW/ratio);
 if(cellH*rows>16000){cellH=Math.floor(16000/rows);cellW=Math.round(cellH*ratio)}
 const cvs=document.createElement('canvas');cvs.width=cols*cellW;cvs.height=rows*cellH;const ctx=cvs.getContext('2d');if(!ctx)return;
 ctx.fillStyle='#000';ctx.fillRect(0,0,cvs.width,cvs.height);app.toast('Building the cube image…');
 for(let i=0;i<list.length;i++){const img=new Image;img.src=list[i].url;try{await loadImg(img);const s=Math.min(cellW/img.naturalWidth,cellH/img.naturalHeight),w=img.naturalWidth*s,h=img.naturalHeight*s;ctx.drawImage(img,(i%cols)*cellW+(cellW-w)/2,Math.floor(i/cols)*cellH+(cellH-h)/2,w,h)}catch{}}
 cvs.toBlob(blob=>{if(!blob){app.toast('The cube is too large for the browser to export');return}const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=`${scope==='finals'?'finalists':'picks'}-cube-${list.length}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000)},'image/png');
}
async function copyCubeFiles(){
 const folder=byId('cubeFolder').value.trim(),list=scopeList();
 if(!folder){app.toast('Type the folder to copy the files into');byId('cubeFolder').focus();return}
 if(!list.length)return;
 try{localStorage.setItem('ls-grid-copy-folder',folder)}catch{/* blocked */}
 const btn=byId('cubeCopy');btn.disabled=true;let ok=0,skipped=0,lastError='';
 try{for(const r of list){
  btn.textContent=`Copying ${ok+skipped+1}/${list.length}…`;
  if(!/\.(png|jpe?g|webp)$/i.test(r.file.name)){skipped++;continue}
  try{const res=await fetch(`/api/files/save?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(r.file.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Lora-Studio':'1'},body:r.file});
   const body=await res.json().catch(()=>({}));if(!res.ok)throw new Error(body.error||`Copy failed (${res.status})`);ok++}
  catch(e){lastError=e.message;skipped++;if(/folder|path/i.test(e.message))break}
 }}finally{btn.disabled=false;btn.textContent='Copy files'}
 app.toast(lastError&&!ok?`Could not copy: ${lastError}`:`Copied ${ok} file${ok===1?'':'s'} to ${folder}${skipped?` · ${skipped} skipped${lastError?` (${lastError})`:''}`:''}`);
}
function paintModalTier(){const r=currentDetail;if(!r)return;const t=tierOf(r);const p=byId('pickBtn'),f=byId('finalBtn');p.classList.toggle('on',t>=1);f.classList.toggle('on',t===2);p.textContent=t>=1?'♥ Picked':'♥ Pick';f.textContent=t===2?'★ Finalist ✓':'★ Finalist'}
function render(){
 updatePickbar();
 if(scope!=='all'&&records.length){root.classList.remove('strength-mode');byId('clearImages').disabled=false;app.setCount('grid',records.length);renderCube(byId('results'));return}
 const groups=buildGroups(),withMeta=records.filter(r=>r.analysis.detected).length,warnings=records.length-withMeta;
 byId('stats').innerHTML=`<span><b>${records.length}</b> images loaded</span><span><b>${groups.length}</b> groups shown</span><span><b>${withMeta}</b> metadata recognized</span>${records.length?`<span><b>${records.length-new Set(groups.flat()).size}</b> hidden by filters</span>`:''}`;
 byId('clearImages').disabled=records.length===0;
 root.classList.toggle('has-images',records.length>0);app.setCount('grid',records.length||'');
 const result=byId('results'),view=byId('viewMode').value;
 result.className='layout-'+view;
 root.classList.toggle('strength-mode',view==='strength');
 const banner=byId('galleryBanner'); if(banner)banner.querySelector('strong').textContent=view==='wall'?'CONTACT SHEET':'GROUPED CONTACT SHEET';
 const notice=byId('notice');notice.classList.toggle('show',warnings>0);
 if(warnings)notice.textContent=`${warnings} image${warnings===1?' has':'s have'} no recognized generation metadata. Use original ComfyUI Save Image PNGs; otherwise grouping and labels may not be accurate.`;
 if(!records.length){result.innerHTML='<div class="empty"><div class="big">▧</div><h3>Your comparison contact sheet starts here</h3><p>Drop multiple batches or a folder of original ComfyUI PNG images. See many images side by side.</p></div>';applyColumns();return}
 if(view==='strength'){renderStrength(result);applyColumns();return}
 if(!groups.length){result.innerHTML='<div class="empty"><h3>No matching groups</h3><p>Try removing your search or turning off the “2+ matches” filter.</p></div>';applyColumns();return}
 result.replaceChildren();const mode=byId('groupMode').value;
 if(view==='wall'){
  const wall=document.createElement('section');wall.className='wallcards';
  const seen=new Set(),flat=groups.flat().filter(r=>!seen.has(r)&&seen.add(r));seen.clear();
  for(let i=0;i<groups.length;i++)for(const r of groups[i]){if(seen.has(r))continue;seen.add(r);wall.append(createTile(r,i,mode!=='none',flat))}
  result.append(wall);applyColumns();return;
 }
 // When many images have unique generation settings, keep singleton sets in one
 // multi-column section rather than stacking dozens of one-image groups.
 const singletonRecords=[...new Set(groups.filter(g=>g.length===1).map(g=>g[0]))];
 const displayGroups=groups.filter(g=>g.length>1).map(g=>({images:g,singletons:false}));
 if(singletonRecords.length)displayGroups.push({images:singletonRecords,singletons:true});
 displayGroups.forEach(({images:group,singletons},idx)=>{
  let s=document.createElement('section');s.className='group';
  let h=document.createElement('div');h.className='grouphead';
  let label=document.createElement('div');
  label.innerHTML=singletons
   ? (mode==='bylora'?`<div class="groupname">LoRAs used in only one image <span class="chip">${group.length} images</span></div><div class="groupdetails">Each of these LoRAs appears in a single image. They're shown together in one grid.</div>`:`<div class="groupname">Other images · individual settings <span class="chip">${group.length} images</span></div><div class="groupdetails">These images have no matching image with the selected grouping. They're still shown together in a grid.</div>`)
   : `<div class="groupname">${html(groupTitle(group,mode,idx))} <span class="chip">${group.length} images</span>${mode==='compare'&&new Set(group.map(r=>r.analysis.loras.map(shortLora).join('|'))).size>1?'<span class="chip tone">LoRA variants</span>':''}</div><div class="groupdetails">${html(groupSub(group,mode))}</div>`;
  h.append(label);
  let buttons=document.createElement('div');buttons.className='groupbuttons';
  let exportBtn=document.createElement('button');exportBtn.className='btn tiny';exportBtn.textContent='↓ Export grid';exportBtn.addEventListener('click',()=>exportGroup(group,idx));buttons.append(exportBtn);
  let fold=document.createElement('button');fold.className='btn tiny';fold.textContent='Collapse';buttons.append(fold);h.append(buttons);s.append(h);
  let tiles=document.createElement('div');tiles.className='cards';for(const r of group)tiles.append(createTile(r,idx,false,group));
  s.append(tiles);
  fold.addEventListener('click',()=>{tiles.hidden=!tiles.hidden;fold.textContent=tiles.hidden?'Expand':'Collapse';tiles.style.display=tiles.hidden?'none':'grid'});
  result.append(s);
 });
 applyColumns();
}
async function getImageData(file){const info=await readImageFile(file);return {meta:info.map,width:info.width,height:info.height,analysis:info.analysis,info}}
export async function addFiles(files){if(busy){return}const choices=[...files].filter(f=>/\.(png|webp|jpe?g|avif)$/i.test(f.name));if(!choices.length)return;busy=true;const add=byId('addImages'),folder=byId('addFolder'),old=add.textContent;add.disabled=folder.disabled=true;let count=0;try{for(const f of choices){let id=[f.name,f.size,f.lastModified,f.webkitRelativePath||''].join('|');if(knownFiles.has(id))continue;knownFiles.add(id);try{const data=await getImageData(f);records.push({file:f,key:tierKey(f),url:URL.createObjectURL(f),...data})}catch(e){records.push({file:f,key:tierKey(f),url:URL.createObjectURL(f),meta:{},analysis:analyze({}),width:null,height:null});console.warn('Could not read metadata',f.name,e)}count++;if(count%12===0){add.textContent=`Loading ${count}…`;await new Promise(resolve=>setTimeout(resolve,0));scheduleRender()}}}finally{busy=false;add.disabled=folder.disabled=false;add.textContent=old;render()}}
async function exportGroup(group,index){
 const width=420,imgH=420,footerH=82,cols=Math.min(group.length,4),rows=Math.ceil(group.length/cols),gap=10;
 const cvs=document.createElement('canvas');cvs.width=cols*(width+gap)+gap;cvs.height=rows*(imgH+footerH+gap)+gap;const ctx=cvs.getContext('2d');if(!ctx)return;ctx.fillStyle='#101722';ctx.fillRect(0,0,cvs.width,cvs.height);
 function drawLine(text,x,y,max){ctx.fillText(String(text).slice(0,100),x,y,max)}
 function wrapCanvasName(name,maxWidth){
  const words=String(name).split(/(\s+|(?<=[_-]))/).filter(Boolean),lines=[];let line='';
  for(const word of words){if(ctx.measureText(line+word).width<=maxWidth){line+=word;continue}
   if(line.trim())lines.push(line.trim());line='';
   for(const c of word){if(ctx.measureText(line+c).width>maxWidth&&line){lines.push(line);line=''}line+=c}}
  if(line.trim())lines.push(line.trim());return lines;
 }
 // Name band sits BELOW each image (same height for every cell so rows stay aligned).
 ctx.font='700 21px "Segoe UI",system-ui';
 const labelLines=group.map(r=>r.analysis.loras.length?r.analysis.loras.flatMap(l=>{const ls=wrapCanvasName(l.name,width-24);if(l.model!==null)ls[ls.length-1]+='  @'+strengthText(l);return ls}):[r.analysis.detected?'No LoRA':'LoRA unknown']);
 const lineH=26,bandH=Math.min(8,Math.max(...labelLines.map(l=>l.length)))*lineH+16,cellH=bandH+imgH+footerH;
 cvs.height=rows*(cellH+gap)+gap;ctx.fillStyle='#101722';ctx.fillRect(0,0,cvs.width,cvs.height);
 for(let ix=0;ix<group.length;ix++){
  const r=group[ix],x=gap+(ix%cols)*(width+gap),y=gap+Math.floor(ix/cols)*(cellH+gap);
  ctx.fillStyle='#1b2633';ctx.fillRect(x,y,width,cellH);
  ctx.fillStyle='#0a0f15';ctx.fillRect(x,y+imgH,width,bandH);
  const lines=labelLines[ix].slice(0,8);
  ctx.font='700 21px "Segoe UI",system-ui';ctx.fillStyle=r.analysis.loras.length?'#ffe94d':'#b9c6d2';ctx.textBaseline='top';
  lines.forEach((line,j)=>ctx.fillText(line,x+12,y+imgH+8+j*lineH,width-24));
  let img=new Image;img.src=r.url;
  try{await loadImg(img);let w=img.naturalWidth,h=img.naturalHeight,scale=Math.min(width/w,imgH/h);ctx.drawImage(img,x+(width-w*scale)/2,y+(imgH-h*scale)/2,w*scale,h*scale)}catch{}
  ctx.textBaseline='alphabetic';
  ctx.fillStyle='#d7e9fa';ctx.font='bold 14px system-ui';drawLine(r.analysis.model,x+12,y+imgH+bandH+24,width-24);
  ctx.fillStyle='#9cadbc';ctx.font='11px system-ui';drawLine(r.file.name,x+12,y+imgH+bandH+46,width-24);
 }
 cvs.toBlob(blob=>{if(!blob)return;let link=document.createElement('a'),url=URL.createObjectURL(blob);link.href=url;link.download=`lora-lens-group-${index+1}.png`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000)},'image/png')
}
// Previous/next browsing walks the set the clicked image came from (strength set, group, or whole grid).
let navList=[],navIndex=-1;
function updateNav(){const n=navList.length,multi=n>1;byId('navPrev').disabled=!multi;byId('navNext').disabled=!multi;
 let label='';if(multi){label=`${navIndex+1} / ${n}`;if(byId('viewMode').value==='strength'){const set=strengthSets().find(s=>s.all===navList||s.all.includes(navList[navIndex]));if(set){const L=strengthLines(navList[navIndex],set);label+=` · ${L.main.replace(/\n/g,' · ')}`}}}
 byId('navCount').textContent=label}
function navigate(step){if(navList.length<2||!byId('modal').classList.contains('open'))return;navIndex=(navIndex+step+navList.length)%navList.length;showDetail(navList[navIndex],navList)}
function showDetail(r,list){
 navList=list&&list.length?list:[r];navIndex=Math.max(0,navList.indexOf(r));currentDetail=r;
 byId('modalImg').src=r.url;byId('modalTitle').textContent=r.file.name;
 const a=r.analysis,positive=r.info&&r.info.prompt;
 const kv=[['Base model',a.model],['Seed',a.stats.seed],['Sampler',a.stats.sampler],['Scheduler',a.stats.scheduler],['Steps',a.stats.steps],['CFG',a.stats.cfg],['Denoise',a.stats.denoise],['Image size',r.width?`${r.width} × ${r.height}`:'Unknown'],['Prompt',positive||a.prompt||'Not found']];
 const dl=byId('modalDetails');dl.innerHTML='<dt>LoRAs</dt>';
 const dd=document.createElement('dd');dl.append(dd);
 if(!a.loras.length)dd.textContent='None found';
 for(const l of a.loras){
  // Link each LoRA to your library when you have it (filled in once the library has loaded).
  const line=document.createElement('div');line.textContent=shortLora(l);dd.append(line);
  whenReady().then(()=>{if(currentDetail!==r)return;const owned=findByName(l.name);if(!owned.length)return;
   const b=document.createElement('button');b.type='button';b.className='lib-link';b.textContent='✓ in My LoRAs';b.title='Show '+owned[0].filename;
   b.onclick=()=>{closeDetail();app.go('loras',{search:owned[0].filename})};line.append(b)});
 }
 dl.insertAdjacentHTML('beforeend',kv.map(([name,value])=>`<dt>${html(name)}</dt><dd>${html(fmt(value))}</dd>`).join(''));
 byId('copyPrompt').disabled=!positive;paintModalTier();
 byId('raw').textContent=JSON.stringify(r.meta,null,2);byId('modal').classList.add('open');updateNav()}
let currentDetail=null;
function closeDetail(){byId('modal').classList.remove('open')}
export function init(){
byId('addImages').addEventListener('click',()=>byId('imageInput').click());byId('addFolder').addEventListener('click',()=>byId('folderInput').click());byId('imageInput').addEventListener('change',e=>{addFiles(e.target.files);e.target.value=''});byId('folderInput').addEventListener('change',e=>{addFiles(e.target.files);e.target.value=''});
byId('clearImages').addEventListener('click',()=>{for(const r of records)URL.revokeObjectURL(r.url);records.length=0;knownFiles.clear();render()});
['search','groupMode','sort','viewMode','multiOnly','ignoreSeed','includeOff'].forEach(id=>byId(id).addEventListener(id==='search'?'input':'change',scheduleRender));
byId('columns').addEventListener('input',applyColumns);window.addEventListener('resize',()=>{applyColumns();sizeCube()});
byId('scope').addEventListener('click',e=>{const b=e.target.closest('button[data-scope]');if(b&&b.dataset.scope!==scope)setScope(b.dataset.scope)});
byId('cubeLess').addEventListener('click',()=>{const n=scopeList().length;cubeUI.cols=Math.max(1,cubeCols(n)-1);sizeCube()});
byId('cubeMore').addEventListener('click',()=>{const n=scopeList().length;cubeUI.cols=Math.min(n,cubeCols(n)+1);sizeCube()});
byId('cubeAuto').addEventListener('click',()=>{cubeUI.cols=0;sizeCube()});
byId('cubeFit').addEventListener('change',sizeCube);
byId('cubeExport').addEventListener('click',exportCube);
byId('cubeNames').addEventListener('click',()=>{const l=scopeList();if(l.length)app.copy(l.map(r=>r.file.webkitRelativePath||r.file.name).join('\n'),`Copied ${l.length} file name${l.length===1?'':'s'}`)});
try{byId('cubeFolder').value=localStorage.getItem('ls-grid-copy-folder')||''}catch{/* blocked */}
byId('cubeCopy').addEventListener('click',copyCubeFiles);
byId('cubeBrowse').addEventListener('click',async()=>{const f=await chooseFolder({title:'Choose the folder to copy your picks into',start:byId('cubeFolder').value.trim()});if(f){byId('cubeFolder').value=f;try{localStorage.setItem('ls-grid-copy-folder',f)}catch{/* blocked */}}});
byId('cubeFolder').addEventListener('keydown',e=>{if(e.key==='Enter')copyCubeFiles()});
byId('cubeClear').addEventListener('click',()=>{const l=scopeList();if(!l.length)return;if(!confirm(scope==='finals'?`Send all ${l.length} finalists back to Picks?`:`Remove all ${l.length} images from your picks (finalists too)?`))return;for(const r of l){if(scope==='finals')tiers.set(r.key,1);else tiers.delete(r.key)}saveTiers();render()});
byId('pickBtn').addEventListener('click',()=>{if(currentDetail)togglePick(currentDetail)});
byId('finalBtn').addEventListener('click',()=>{if(currentDetail)toggleFinal(currentDetail)});
byId('focusBtn').addEventListener('click',()=>{const on=root.classList.toggle('gallery-focus');document.body.classList.toggle('focus-mode',on);byId('focusBtn').textContent=on?'Exit expanded view ✕':'Expand gallery ⛶';applyColumns()});
const drop=byId('dropzone');let dragDepth=0;document.addEventListener('dragover',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files'))e.preventDefault()});document.addEventListener('drop',e=>{if(e.dataTransfer&&[...e.dataTransfer.types].includes('Files'))e.preventDefault()});
drop.addEventListener('dragenter',e=>{e.preventDefault();dragDepth++;drop.classList.add('dragging')});drop.addEventListener('dragleave',e=>{e.preventDefault();if(--dragDepth<=0){dragDepth=0;drop.classList.remove('dragging')}});drop.addEventListener('dragover',e=>{e.preventDefault();e.dataTransfer.dropEffect='copy'});drop.addEventListener('drop',async e=>{e.preventDefault();dragDepth=0;drop.classList.remove('dragging');const dt=e.dataTransfer;if(!dt)return;const entries=[...dt.items].map(i=>i.webkitGetAsEntry?.()).filter(Boolean);if(entries.some(e=>e.isDirectory)){let files=[];async function walk(entry){if(entry.isFile){let f=await new Promise(resolve=>entry.file(resolve,()=>resolve(null)));if(f)files.push(f)}else if(entry.isDirectory){let reader=entry.createReader();while(true){const chunk=await new Promise(resolve=>reader.readEntries(resolve,()=>resolve([])));if(!chunk.length)break;await Promise.all(chunk.map(walk))}}}await Promise.all(entries.map(walk));addFiles(files)}else addFiles(dt.files)});
byId('closeModal').addEventListener('click',closeDetail);byId('copyPrompt').addEventListener('click',()=>{const p=currentDetail&&currentDetail.info&&currentDetail.info.prompt;if(p)app.copy(p,'Prompt copied')});byId('openPrompt').addEventListener('click',()=>{if(!currentDetail)return;const f=currentDetail.file;closeDetail();app.go('prompt',{file:f})});byId('modal').addEventListener('click',e=>{if(e.target===byId('modal'))closeDetail()});byId('navPrev').addEventListener('click',e=>{e.stopPropagation();navigate(-1)});byId('navNext').addEventListener('click',e=>{e.stopPropagation();navigate(1)});
let wheelLock=0;byId('modal').querySelector('.modalpic').addEventListener('wheel',e=>{if(navList.length<2)return;e.preventDefault();const now=Date.now();if(now-wheelLock<180||Math.abs(e.deltaY)<4)return;wheelLock=now;navigate(e.deltaY>0?1:-1)},{passive:false});
document.addEventListener('keydown',e=>{
 if(!app.isActive('grid'))return;
 // Strength view: arrows step the active set (flip: next strength; side by side: B, or A with Shift); Space plays.
 const typing=['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)&&document.activeElement.type!=='checkbox';
 if(!byId('modal').classList.contains('open')&&!typing&&byId('viewMode').value==='strength'&&activeUI&&activeUI.root?.isConnected){
  if((e.key==='ArrowLeft'||e.key==='ArrowRight')&&step(activeUI,e.key==='ArrowLeft'?-1:1,e.shiftKey)){e.preventDefault();return}
  if(e.key===' '&&activeUI.mode==='flip'&&activeUI.playBtn){e.preventDefault();activeUI.playBtn.click();return}
 }
 if(byId('modal').classList.contains('open')&&currentDetail&&!e.ctrlKey&&!e.metaKey&&!e.altKey){const k=e.key.toLowerCase();if(k==='p'){e.preventDefault();togglePick(currentDetail);return}if(k==='s'){e.preventDefault();toggleFinal(currentDetail);return}}
 if(e.key==='Escape')closeDetail();if(byId('modal').classList.contains('open')&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){e.preventDefault();navigate(e.key==='ArrowLeft'?-1:1)}if(e.key.toLowerCase()==='f'&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName)&&!byId('modal').classList.contains('open'))byId('focusBtn').click()});
}

// The grid measures its own width, which is 0 while the tab is hidden.
export function show(){requestAnimationFrame(()=>{applyColumns();sizeCube();if(byId('viewMode').value==='strength')sizeStrengthGrids()})}
/** From the Prompt tab: { files: [File] } */
export function receive(action){if(action.files)addFiles(action.files).then(()=>app.toast(`Added to Grid · ${records.length} image${records.length===1?'':'s'} loaded`))}
