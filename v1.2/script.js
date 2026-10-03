/* ═══════════════════════════════════════════════════════════════
   X-CUT Studio — Filmora-style browser NLE
   ═══════════════════════════════════════════════════════════════ */
(function(){
"use strict";

/* ───────────── Utilities ───────────── */
const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
const uid = () => Math.random().toString(36).slice(2,10);
const now = () => performance.now();

function fmtTime(t){
  if(!isFinite(t)||t<0) t=0;
  const m = Math.floor(t/60);
  const s = t%60;
  return String(m).padStart(2,'0')+':'+s.toFixed(1).padStart(4,'0');
}
function fmtTC(t, fps=30){
  if(!isFinite(t)||t<0) t=0;
  const f = Math.floor((t*fps)%fps);
  const s = Math.floor(t)%60;
  const m = Math.floor(t/60)%60;
  const h = Math.floor(t/3600);
  return [h,m,s,f].map(n=>String(n).padStart(2,'0')).join(':');
}
function bytes(n){
  if(!isFinite(n)||n<=0) return '0 KB';
  const u=['B','KB','MB','GB']; let i=0;
  while(n>=1024 && i<u.length-1){n/=1024;i++;}
  return (n>=10||i===0?n.toFixed(0):n.toFixed(1))+' '+u[i];
}

/* Toast */
let toastT=null;
function toast(msg){
  const el=$('#toast'); el.textContent=msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT=setTimeout(()=>el.classList.remove('show'),2200);
}

/* ═══════════════════════════════════════════════════════════════
   STATE MODEL
   ═══════════════════════════════════════════════════════════════ */
const state = {
  // Media pool
  media: [],            // {id,name,kind,url,size,width,height,duration,thumb}
  selectedMediaId: null,

  // Timeline
  tracks: {
    V2:{type:'video',clips:[],muted:false,solo:false,locked:false,hidden:false},
    V1:{type:'video',clips:[],muted:false,solo:false,locked:false,hidden:false},
    A1:{type:'audio',clips:[],muted:false,solo:false,locked:false},
    A2:{type:'audio',clips:[],muted:false,solo:false,locked:false}
  },
  selectedClipId: null,

  // Playback
  playing:false,
  currentTime:0,       // in project seconds
  duration:0,
  fps:30,

  // View
  pxPerSec: 80,
  snapping:true,
  tool:'select',

  // Undo
  history:[],
  redoStack:[],

  // UI
  activeLib:'media',
  activeInsp:'video'
};

/* Active timeline clip accessor */
function activeClip(){
  if(!state.selectedClipId) return null;
  for(const t of Object.keys(state.tracks)){
    const c = state.tracks[t].clips.find(c=>c.id===state.selectedClipId);
    if(c) return {clip:c, track:t};
  }
  return null;
}

/* Project duration = max clip end across all tracks */
function computeDuration(){
  let max=0;
  for(const t of Object.keys(state.tracks)){
    for(const c of state.tracks[t].clips){
      max = Math.max(max, c.start + c.duration);
    }
  }
  state.duration = max;
  return max;
}

/* ═══════════════════════════════════════════════════════════════
   UNDO / REDO
   ═══════════════════════════════════════════════════════════════ */
function snapshot(){
  return JSON.stringify({
    tracks: state.tracks,
    media: state.media.map(m=>({id:m.id,name:m.name,kind:m.kind,url:m.url,size:m.size,width:m.width,height:m.height,duration:m.duration})),
    duration: state.duration
  });
}
function pushHistory(label='edit'){
  state.history.push({label, data:snapshot()});
  if(state.history.length>60) state.history.shift();
  state.redoStack.length=0;
  updateHistoryButtons();
}
function restore(snap){
  const s = JSON.parse(snap);
  state.tracks = s.tracks;
  state.media = s.media;
  state.duration = s.duration;
  // re-bind selected clip
  if(state.selectedClipId){
    const found = activeClip();
    if(!found) state.selectedClipId = null;
  }
  renderTimeline();
  renderRuler();
  updateInspector();
}
function undo(){
  if(!state.history.length){ toast('Nothing to undo'); return; }
  const cur = snapshot();
  const entry = state.history.pop();
  state.redoStack.push({label:entry.label, data:cur});
  restore(entry.data);
  updateHistoryButtons();
  toast('Undo: '+entry.label);
}
function redo(){
  if(!state.redoStack.length){ toast('Nothing to redo'); return; }
  const cur = snapshot();
  const entry = state.redoStack.pop();
  state.history.push({label:entry.label, data:cur});
  restore(entry.data);
  updateHistoryButtons();
  toast('Redo: '+entry.label);
}
function updateHistoryButtons(){
  $('#btn-undo').disabled = !state.history.length;
  $('#btn-redo').disabled = !state.redoStack.length;
}
updateHistoryButtons();

/* ═══════════════════════════════════════════════════════════════
   MEDIA IMPORT + LIBRARY
   ═══════════════════════════════════════════════════════════════ */
function kindOf(file){
  const t = file.type||'';
  if(t.startsWith('video/')) return 'video';
  if(t.startsWith('audio/')) return 'audio';
  if(t.startsWith('image/')) return 'image';
  const ext=(file.name.split('.').pop()||'').toLowerCase();
  if(['mp4','webm','mov','m4v','mkv'].includes(ext)) return 'video';
  if(['mp3','wav','aac','flac','ogg','m4a'].includes(ext)) return 'audio';
  if(['png','jpg','jpeg','gif','webp','bmp'].includes(ext)) return 'image';
  return 'video';
}

async function probeMedia(item){
  return new Promise(res=>{
    if(item.kind==='video'){
      const v=document.createElement('video');
      v.preload='metadata'; v.muted=true;
      v.onloadedmetadata=()=>{
        item.width=v.videoWidth; item.height=v.videoHeight;
        item.duration=v.duration; res();
      };
      v.onerror=()=>res();
      v.src=item.url;
    } else if(item.kind==='audio'){
      const a=document.createElement('audio');
      a.preload='metadata';
      a.onloadedmetadata=()=>{ item.duration=a.duration; res(); };
      a.onerror=()=>res();
      a.src=item.url;
    } else if(item.kind==='image'){
      const im=new Image();
      im.onload=()=>{ item.width=im.width; item.height=im.height; item.duration=5; res(); };
      im.onerror=()=>res();
      im.src=item.url;
    } else res();
  });
}

async function makeThumb(item){
  if(item.kind==='video'){
    return new Promise(res=>{
      const v=document.createElement('video');
      v.src=item.url; v.muted=true; v.preload='metadata';
      v.onloadeddata=()=>{
        v.currentTime = Math.min(0.5, (v.duration||1)*0.1);
        v.onseeked=()=>{
          const c=document.createElement('canvas');
          c.width=160; c.height=90;
          c.getContext('2d').drawImage(v,0,0,160,90);
          try{ res(c.toDataURL('image/jpeg',0.6)); }catch(e){ res(null); }
        };
      };
      v.onerror=()=>res(null);
    });
  }
  if(item.kind==='image') return item.url;
  return null;
}

async function addMediaFromFile(file){
  const kind = kindOf(file);
  const item = {
    id: uid(),
    name: file.name,
    kind,
    url: URL.createObjectURL(file),
    size: file.size,
    width:0, height:0, duration:0,
    thumb: null
  };
  await probeMedia(item);
  item.thumb = await makeThumb(item);
  state.media.push(item);
  pushHistory('import '+item.name);
  renderMediaGrid();
  toast(`Imported: ${item.name}`);
}

async function handleFiles(files){
  const list = Array.from(files||[]);
  if(!list.length) return;
  for(const f of list) await addMediaFromFile(f);
}

/* ── Media grid render ── */
function renderMediaGrid(){
  const grid = $('#media-grid');
  const q = ($('#lib-search').value||'').toLowerCase().trim();
  grid.innerHTML = '';
  const filtered = state.media.filter(m => !q || m.name.toLowerCase().includes(q));
  if(!filtered.length){
    grid.innerHTML = `<div class="empty-state" id="media-empty">
      <div class="empty-icon">⬆</div>
      <div class="empty-title">Import your media</div>
      <div class="empty-sub">Drag &amp; drop files here, or click Import</div>
    </div>`;
    return;
  }
  filtered.forEach(m=>{
    const card = document.createElement('div');
    card.className = 'media-card' + (m.id===state.selectedMediaId?' selected':'');
    card.draggable = true;
    card.dataset.id = m.id;
    const icon = m.kind==='audio'?'🎵':m.kind==='image'?'🖼️':'🎬';
    card.innerHTML = `
      <div class="media-card-thumb">
        ${m.thumb?`<img src="${m.thumb}" alt="">`:icon}
        <span class="kind-badge">${m.kind.toUpperCase()}</span>
      </div>
      <div class="media-card-name">${m.name}</div>
      <div class="media-card-meta">${bytes(m.size)}${m.duration?` • ${fmtTime(m.duration)}`:''}</div>
    `;
    card.addEventListener('click', ()=>{
      state.selectedMediaId = m.id;
      renderMediaGrid();
    });
    card.addEventListener('dblclick', ()=>{
      // add to appropriate track
      addMediaToTimeline(m);
    });
    card.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/xcut-media', m.id);
      e.dataTransfer.effectAllowed = 'copy';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', ()=>card.classList.remove('dragging'));
    grid.appendChild(card);
  });
}

/* ═══════════════════════════════════════════════════════════════
   TIMELINE — clip creation
   ═══════════════════════════════════════════════════════════════ */
function addMediaToTimeline(item, targetTrack){
  if(!item) return;
  let track = targetTrack;
  if(!track){
    if(item.kind==='audio') track = state.tracks.A1.clips.length<=state.tracks.A2.clips.length?'A1':'A2';
    else track = state.tracks.V1.clips.length<=state.tracks.V2.clips.length?'V1':'V2';
  }
  const clip = {
    id: uid(),
    mediaId: item.id,
    name: item.name,
    kind: item.kind,
    start: state.currentTime,
    duration: item.duration || 5,
    srcIn: 0,
    srcOut: item.duration || 5,
    // Properties
    speed: 1,
    reverse: false,
    volume: 1,
    opacity: 1,
    scale: 100,
    posX: 0,
    posY: 0,
    rotation: 0,
    crop: {top:0,bottom:0,left:0,right:0},
    color: {brightness:0,contrast:0,saturation:0,hue:0,gamma:1,vignette:0},
    effect: 'none',
    keyframes: [],
    transitionIn: null,
    transitionOut: null,
    selected: false
  };
  // Avoid overlap: place at first free slot if needed (naive)
  const trackObj = state.tracks[track];
  const conflict = trackObj.clips.find(c => 
    clip.start < c.start + c.duration && clip.start + clip.duration > c.start);
  if(conflict) clip.start = conflict.start + conflict.duration;

  trackObj.clips.push(clip);
  state.tracks[track].clips.sort((a,b)=>a.start-b.start);
  state.selectedClipId = clip.id;
  computeDuration();
  pushHistory('add clip');
  renderTimeline();
  renderRuler();
  updateInspector();
  toast(`${item.name} → ${track}`);
}

/* ═══════════════════════════════════════════════════════════════
   TIMELINE RENDER
   ═══════════════════════════════════════════════════════════════ */
function laneEl(track){ return $(`.track-lane[data-track="${track}"]`); }

function renderTimeline(){
  for(const t of Object.keys(state.tracks)){
    const lane = laneEl(t);
    if(!lane) continue;
    lane.innerHTML = '';
    lane.classList.toggle('audio', state.tracks[t].type==='audio');
    state.tracks[t].clips.forEach(c=>{
      lane.appendChild(buildClipEl(c,t));
    });
  }
  positionPlayhead();
}

function buildClipEl(c, track){
  const el = document.createElement('div');
  el.className = `clip ${c.kind}` + (c.id===state.selectedClipId?' selected':'');
  el.dataset.id = c.id;
  el.style.left = (c.start * state.pxPerSec) + 'px';
  el.style.width = Math.max(8, c.duration * state.pxPerSec) + 'px';
  if(c.transitionIn) el.classList.add('transition-overlay');
  const item = state.media.find(m=>m.id===c.mediaId);
  el.innerHTML = `
    <span class="clip-label">${c.name}</span>
    ${c.thumbStrip?`<div class="clip-thumbs">${c.thumbStrip.map(u=>`<img src="${u}">`).join('')}</div>`:''}
    <div class="clip-handle left" data-handle="left"></div>
    <div class="clip-handle right" data-handle="right"></div>
  `;
  el.addEventListener('mousedown', e=>{
    if(e.target.classList.contains('clip-handle')) return;
    selectClip(c.id);
    const startX = e.clientX;
    const startPos = c.start;
    const startTrack = track;
    let moved=false;
    el.style.zIndex='5';
    const move = ev=>{
      const dx = (ev.clientX - startX)/state.pxPerSec;
      if(Math.abs(dx)>0.02) moved=true;
      let newStart = Math.max(0, startPos + dx);
      if(state.snapping) newStart = snapTime(newStart, c.id);
      // Cross-track move
      const lanes = $$('.track-lane');
      let over = null;
      for(const ln of lanes){
        const r = ln.getBoundingClientRect();
        if(ev.clientY>=r.top && ev.clientY<=r.bottom){
          const tt = ln.dataset.track;
          if(c.kind==='audio' && state.tracks[tt].type==='audio') over=tt;
          else if(c.kind!=='audio' && state.tracks[tt].type==='video') over=tt;
        }
      }
      c.start = newStart;
      el.style.left = (c.start * state.pxPerSec)+'px';
      if(over && over!==track){
        // move across tracks
        const src = state.tracks[track].clips;
        const idx = src.indexOf(c);
        if(idx>=0) src.splice(idx,1);
        state.tracks[over].clips.push(c);
        state.tracks[over].clips.sort((a,b)=>a.start-b.start);
        track = over;
        // re-parent DOM
        laneEl(over).appendChild(el);
      }
      positionPlayhead();
    };
    const up = ()=>{
      window.removeEventListener('mousemove',move);
      window.removeEventListener('mouseup',up);
      el.style.zIndex='';
      if(moved){ computeDuration(); pushHistory('move clip'); renderTimeline(); }
    };
    window.addEventListener('mousemove',move);
    window.addEventListener('mouseup',up);
  });

  // Trim handles
  el.querySelectorAll('.clip-handle').forEach(h=>{
    h.addEventListener('mousedown', e=>{
      e.stopPropagation();
      selectClip(c.id);
      const side = h.dataset.handle;
      const startX = e.clientX;
      const orig = {start:c.start, duration:c.duration, srcIn:c.srcIn, srcOut:c.srcOut};
      const move = ev=>{
        const dx = (ev.clientX - startX)/state.pxPerSec;
        if(side==='left'){
          let ns = Math.max(0, orig.start + dx);
          let nd = orig.duration - (ns - orig.start);
          if(nd < 0.1){ nd = 0.1; ns = orig.start + orig.duration - 0.1; }
          c.start = ns;
          c.duration = nd;
          c.srcIn = orig.srcIn + (ns - orig.start) * c.speed;
        } else {
          let nd = Math.max(0.1, orig.duration + dx);
          c.duration = nd;
          c.srcOut = orig.srcIn + nd * c.speed;
        }
        el.style.left = (c.start * state.pxPerSec)+'px';
        el.style.width = Math.max(8, c.duration * state.pxPerSec)+'px';
        positionPlayhead();
      };
      const up = ()=>{
        window.removeEventListener('mousemove',move);
        window.removeEventListener('mouseup',up);
        computeDuration(); pushHistory('trim clip'); renderTimeline();
      };
      window.addEventListener('mousemove',move);
      window.addEventListener('mouseup',up);
    });
  });

  return el;
}

function selectClip(id){
  state.selectedClipId = id;
  $$('.clip').forEach(el=>el.classList.toggle('selected', el.dataset.id===id));
  updateInspector();
}

/* ═══════════════════════════════════════════════════════════════
   SNAPPING
   ═══════════════════════════════════════════════════════════════ */
function snapTime(t, excludeId){
  if(!state.snapping) return t;
  const points = [0, state.currentTime];
  for(const tn of Object.keys(state.tracks)){
    for(const c of state.tracks[tn].clips){
      if(c.id===excludeId) continue;
      points.push(c.start, c.start+c.duration);
    }
  }
  const threshold = 8 / state.pxPerSec;
  let best = t, bestDist = threshold;
  for(const p of points){
    const d = Math.abs(p-t);
    if(d < bestDist){ best = p; bestDist = d; }
  }
  return best;
}

/* ═══════════════════════════════════════════════════════════════
   RULER
   ═══════════════════════════════════════════════════════════════ */
function renderRuler(){
  const ruler = $('#ruler');
  if(!ruler) return;
  ruler.innerHTML='';
  const width = Math.max(state.duration + 20, 60) * state.pxPerSec;
  ruler.style.width = width+'px';
  $('#timeline-content').style.width = (width + 100) + 'px';
  // Determine tick interval from pxPerSec
  let step = 1;
  if(state.pxPerSec < 30) step = 5;
  else if(state.pxPerSec < 60) step = 2;
  else if(state.pxPerSec > 200) step = 0.5;
  for(let t=0; t<=width/state.pxPerSec; t+=step){
    const x = t*state.pxPerSec;
    const major = Math.abs(t % (step*5)) < 0.001 || Math.abs((t % (step*5)) - step*5) < 0.001;
    const tick = document.createElement('div');
    tick.className = 'ruler-tick'+(major?' major':'');
    tick.style.left = x+'px';
    ruler.appendChild(tick);
    if(major){
      const lbl = document.createElement('div');
      lbl.className = 'ruler-label';
      lbl.style.left = x+'px';
      lbl.textContent = fmtTime(t).replace(/^00:/,'');
      ruler.appendChild(lbl);
    }
  }
  // Clicking ruler scrubs
  ruler.onmousedown = e=>{
    const rect = ruler.getBoundingClientRect();
    const move = ev=>{
      const x = ev.clientX - rect.left;
      state.currentTime = Math.max(0, x/state.pxPerSec);
      positionPlayhead();
      seekVideo(state.currentTime);
    };
    const up = ()=>{
      window.removeEventListener('mousemove',move);
      window.removeEventListener('mouseup',up);
    };
    move(e);
    window.addEventListener('mousemove',move);
    window.addEventListener('mouseup',up);
  };
}

/* ═══════════════════════════════════════════════════════════════
   PLAYHEAD + SEEK
   ═══════════════════════════════════════════════════════════════ */
function positionPlayhead(){
  const ph = $('#playhead');
  if(!ph) return;
  const headerW = 92;
  ph.style.left = (headerW + state.currentTime*state.pxPerSec) + 'px';
}
function seekVideo(t){
  // used when a video element is bound to current clip; here we render on demand
  const proj = projectClipAtTime(t);
  if(proj && proj.clip.kind==='video'){
    const item = state.media.find(m=>m.id===proj.clip.mediaId);
    if(item){
      const v = getOrCreateVideo(item.id);
      const local = proj.clip.srcIn + (t - proj.clip.start) * proj.clip.speed;
      if(Math.abs(v.currentTime - local) > 0.05) v.currentTime = local;
      currentVideo = v;
    }
  }
}

/* Find which clip is at a given project time on the topmost visible track */
function projectClipAtTime(t){
  const order = ['V2','V1']; // topmost first
  for(const tr of order){
    const track = state.tracks[tr];
    if(track.hidden) continue;
    const c = track.clips.find(c => t>=c.start && t<c.start+c.duration);
    if(c) return {clip:c, track:tr};
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════
   WEBGL COMPOSITOR
   ═══════════════════════════════════════════════════════════════ */
const canvas = $('#preview-canvas');
const gl = canvas.getContext('webgl',{preserveDrawingBuffer:true,alpha:false});

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){
  vUv = (aPos+1.0)*0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos,0.0,1.0);
}`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uTime;
uniform vec2 uRes;
uniform float uBrightness;
uniform float uContrast;
uniform float uSaturation;
uniform float uHue;
uniform float uGamma;
uniform float uVignette;
uniform int uFx;
uniform float uFxAmt;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uRotation;
uniform vec4 uCrop;
uniform float uOpacity;

vec3 rgb2hsv(vec3 c){
  vec4 K=vec4(0.0,-1.0/3.0,2.0/3.0,-1.0);
  vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g));
  vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r));
  float d=q.x-min(q.w,q.y);
  return vec3(abs(q.z+(q.w-q.y)/(6.0*d+1e-10)), d/(q.x+1e-10), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0);
  vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www);
  return c.z*mix(K.xxx,clamp(p-K.xxx,0.0,1.0),c.y);
}
float rand(vec2 co){ return fract(sin(dot(co,vec2(12.9898,78.233)))*43758.5453); }

void main(){
  vec2 uv = vUv;
  float cL=uCrop.x, cR=uCrop.y, cT=uCrop.z, cB=uCrop.w;
  vec2 size = vec2(1.0-cL-cR, 1.0-cT-cB);
  uv = vec2((uv.x-cL)/size.x, (uv.y-cT)/size.y);
  float s=sin(uRotation), c=cos(uRotation);
  vec2 p=uv-0.5;
  uv = vec2(p.x*c-p.y*s, p.x*s+p.y*c)+0.5;
  uv = (uv-0.5)/uScale + 0.5 + uOffset;
  float inBounds = step(0.0,uv.x)*step(uv.x,1.0)*step(0.0,uv.y)*step(uv.y,1.0);
  vec3 col = texture2D(uTex, clamp(uv,0.0,1.0)).rgb * inBounds;

  if(uFx==1){ // cinematic
    vec3 hsv=rgb2hsv(col);
    hsv.x=mod(hsv.x+0.05,1.0); hsv.y*=1.15;
    col=mix(col,hsv2rgb(hsv),uFxAmt);
  } else if(uFx==2){ float g=dot(col,vec3(0.299,0.587,0.114)); col=mix(col,vec3(g),uFxAmt); }
  else if(uFx==3){ // VHS
    float sh=sin(uv.y*800.0)*0.02*uFxAmt;
    col=vec3(texture2D(uTex,clamp(uv+vec2(0.004+sh,0.0),0.0,1.0)).r,
             texture2D(uTex,clamp(uv,0.0,1.0)).g,
             texture2D(uTex,clamp(uv-vec2(0.004+sh,0.0),0.0,1.0)).b);
    col += (rand(uv*uTime)-0.5)*0.15*uFxAmt;
  }
  else if(uFx==4){ // glitch
    float bl=floor(uv.y*24.0);
    float j=(rand(vec2(bl,floor(uTime*8.0)))-0.5)*0.08*uFxAmt;
    vec2 u2=vec2(uv.x+j,uv.y);
    col=vec3(texture2D(uTex,clamp(u2+vec2(0.01*uFxAmt,0.0),0.0,1.0)).r,
             texture2D(uTex,clamp(u2,0.0,1.0)).g,
             texture2D(uTex,clamp(u2-vec2(0.01*uFxAmt,0.0),0.0,1.0)).b);
  }
  else if(uFx==5){ float a=0.008*uFxAmt;
    col=vec3(texture2D(uTex,clamp(uv+vec2(a,0.0),0.0,1.0)).r,
             texture2D(uTex,clamp(uv,0.0,1.0)).g,
             texture2D(uTex,clamp(uv-vec2(a,0.0),0.0,1.0)).b);
  }
  else if(uFx==6){ vec3 sep=vec3(dot(col,vec3(.393,.769,.189)),dot(col,vec3(.349,.686,.168)),dot(col,vec3(.272,.534,.131)));
    col=mix(col,sep,uFxAmt); }
  else if(uFx==7){ float g=dot(col,vec3(.299,.587,.114));
    col=mix(col, mix(vec3(0.05,0.0,0.2),vec3(1.0,0.55,0.9),g), uFxAmt); }
  else if(uFx==8){ float lv=mix(64.0,5.0,uFxAmt); col=floor(col*lv)/lv; }
  else if(uFx==9){ col=mix(col,1.0-col,uFxAmt); }
  else if(uFx==10){ float px=mix(1.0,80.0,uFxAmt); vec2 u2=floor(uv*px)/px; col=texture2D(uTex,u2).rgb; }
  else if(uFx==11){ // dream glow
    vec3 b=vec3(0.0); float tot=0.0;
    for(int x=-2;x<=2;x++) for(int y=-2;y<=2;y++){
      b+=texture2D(uTex,clamp(uv+vec2(float(x),float(y))*0.004,0.0,1.0)).rgb; tot+=1.0;
    }
    b/=tot;
    vec3 bloom=max(b-0.55,0.0)*2.0;
    col += bloom*uFxAmt;
  }

  col = col + uBrightness;
  col = (col-0.5)*(1.0+uContrast)+0.5;
  float lum=dot(col,vec3(.299,.587,.114));
  col = mix(vec3(lum),col,1.0+uSaturation);
  vec3 hsv=rgb2hsv(clamp(col,0.0,1.0));
  hsv.x = mod(hsv.x+uHue/360.0,1.0);
  col = hsv2rgb(hsv);
  col = pow(clamp(col,1e-4,1.0), vec3(1.0/uGamma));
  if(uVignette>0.001){
    float d=distance(uv,vec2(0.5));
    float v=smoothstep(0.9,0.25,d);
    col *= mix(1.0,v,uVignette);
  }
  gl_FragColor = vec4(col, uOpacity);
}`;

function compile(src,type){
  const s=gl.createShader(type);
  gl.shaderSource(s,src); gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))
    console.error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(VERT,gl.VERTEX_SHADER));
gl.attachShader(prog, compile(FRAG,gl.FRAGMENT_SHADER));
gl.linkProgram(prog);
gl.useProgram(prog);

const quad = new Float32Array([-1,-1,1,-1,-1,1,1,1]);
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER,quadBuf);
gl.bufferData(gl.ARRAY_BUFFER,quad,gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog,'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos,2,gl.FLOAT,false,0,0);

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D,tex);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);

const U = {};
['uTex','uTime','uRes','uBrightness','uContrast','uSaturation','uHue','uGamma',
 'uVignette','uFx','uFxAmt','uScale','uOffset','uRotation','uCrop','uOpacity']
 .forEach(n=> U[n]=gl.getUniformLocation(prog,n));

const FX_MAP = {none:0,cinematic:1,bw:2,vhs:3,glitch:4,rgbshift:5,sepia:6,duotone:7,
                posterize:8,invert:9,pixelate:10,dreamglow:11};

/* Video element pool — one per media item so we can swap quickly */
const videoPool = new Map();
let currentVideo = null;
function getOrCreateVideo(mediaId){
  if(videoPool.has(mediaId)) return videoPool.get(mediaId);
  const item = state.media.find(m=>m.id===mediaId);
  if(!item) return null;
  const v = document.createElement('video');
  v.src = item.url;
  v.muted = true;
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  v.preload = 'auto';
  v.load();
  videoPool.set(mediaId, v);
  return v;
}

/* ═══════════════════════════════════════════════════════════════
   RENDER LOOP
   ═══════════════════════════════════════════════════════════════ */
let lastFrameTime = now();
let renderRunning = true;

function renderFrame(){
  requestAnimationFrame(renderFrame);
  if(!renderRunning) return;

  const t = now();
  const dt = (t - lastFrameTime)/1000;
  lastFrameTime = t;

  // advance playhead if playing
  if(state.playing){
    state.currentTime += dt;
    if(state.currentTime >= state.duration){
      state.currentTime = state.duration;
      setPlaying(false);
    }
    syncPlaybackVideos();
    positionPlayhead();
    updateTimeReadout();
  }

  // Find top video at playhead
  const proj = projectClipAtTime(state.currentTime);
  if(proj && proj.clip.kind!=='audio'){
    const item = state.media.find(m=>m.id===proj.clip.mediaId);
    if(item){
      const v = getOrCreateVideo(item.id);
      currentVideo = v;
      const local = clamp(proj.clip.srcIn + (state.currentTime - proj.clip.start) * proj.clip.speed, 0, (item.duration||1)-0.01);
      if(v.readyState>=2 && Math.abs(v.currentTime-local) > 0.15 && !state.playing){
        v.currentTime = local;
      }
      if(v.readyState>=2){
        gl.bindTexture(gl.TEXTURE_2D,tex);
        try{ gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,v); }catch(e){}
      }
      gl.viewport(0,0,canvas.width,canvas.height);
      gl.useProgram(prog);
      gl.uniform1i(U.uTex,0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D,tex);
      gl.uniform1f(U.uTime,t/1000);
      gl.uniform2f(U.uRes,canvas.width,canvas.height);
      const c = proj.clip;
      gl.uniform1f(U.uBrightness, c.color.brightness/100*0.6);
      gl.uniform1f(U.uContrast,   c.color.contrast/100);
      gl.uniform1f(U.uSaturation, c.color.saturation/100);
      gl.uniform1f(U.uHue,        c.color.hue);
      gl.uniform1f(U.uGamma,      c.color.gamma);
      gl.uniform1f(U.uVignette,   c.color.vignette/100);
      gl.uniform1i(U.uFx,         FX_MAP[c.effect]||0);
      gl.uniform1f(U.uFxAmt,      1.0);
      gl.uniform2f(U.uScale,      c.scale/100, c.scale/100);
      gl.uniform2f(U.uOffset,     c.posX/100, c.posY/100);
      gl.uniform1f(U.uRotation,   c.rotation*Math.PI/180);
      gl.uniform4f(U.uCrop, c.crop.left/100, c.crop.right/100, c.crop.top/100, c.crop.bottom/100);
      gl.uniform1f(U.uOpacity, c.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      drawOverlays();
    }
  } else {
    // clear to black
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    drawOverlays();
  }
}

function syncPlaybackVideos(){
  const proj = projectClipAtTime(state.currentTime);
  for(const [id,v] of videoPool){
    const isActive = proj && proj.clip.mediaId===id;
    if(isActive && state.playing){
      if(v.paused){
        const c = proj.clip;
        const local = c.srcIn + (state.currentTime - c.start) * c.speed;
        v.currentTime = clamp(local,0,(v.duration||1)-0.05);
        v.playbackRate = c.speed;
        v.volume = 0; // preview silent by default
        v.play().catch(()=>{});
      }
    } else {
      if(!v.paused) v.pause();
    }
  }
}

function setPlaying(p){
  state.playing = p;
  $('#tp-play').textContent = p ? '❚❚' : '▶';
  $('#tp-play').classList.toggle('playing', p);
  syncPlaybackVideos();
}

/* ═══════════════════════════════════════════════════════════════
   OVERLAY (title clips drawn on canvas as 2D text)
   ═══════════════════════════════════════════════════════════════ */
function drawOverlays(){
  // For now, overlay-layer is DOM-based for text clips
  const layer = $('#overlay-layer');
  layer.innerHTML = '';
  const activeTexts = [];
  for(const tn of ['V2','V1']){
    const track = state.tracks[tn];
    if(track.hidden) continue;
    for(const c of track.clips){
      if(c.kind==='text' && state.currentTime>=c.start && state.currentTime<c.start+c.duration){
        activeTexts.push(c);
      }
    }
  }
  activeTexts.forEach(c=>{
    const el = document.createElement('div');
    el.className = 'text-overlay';
    el.style.position='absolute';
    el.style.left = (c.posX+50)+'%';
    el.style.top  = (c.posY+50)+'%';
    el.style.transform='translate(-50%,-50%)';
    el.style.color = c.color||'#fff';
    el.style.fontSize = (c.fontSize||42)+'px';
    el.style.fontFamily = c.fontFamily||'Inter,sans-serif';
    el.style.fontWeight = '700';
    el.style.textShadow = '0 2px 8px rgba(0,0,0,.7)';
    el.style.pointerEvents='none';
    el.textContent = c.text||'Text';
    layer.appendChild(el);
  });
}

/* ═══════════════════════════════════════════════════════════════
   TIMECODE / READOUTS
   ═══════════════════════════════════════════════════════════════ */
function updateTimeReadout(){
  $('#tp-time').textContent = fmtTime(state.currentTime);
  $('#tp-duration').textContent = fmtTime(state.duration);
  $('#timecode-readout').textContent = fmtTC(state.currentTime, state.fps);
}

/* ═══════════════════════════════════════════════════════════════
   INSPECTOR
   ═══════════════════════════════════════════════════════════════ */
function updateInspector(){
  const found = activeClip();
  const title = $('#inspector-title');
  if(!found){
    title.textContent = 'No clip selected';
    // reset values to defaults
    setInspectorValues(defaultClip());
    return;
  }
  title.textContent = found.clip.name + '  ['+found.track+']';
  setInspectorValues(found.clip);
}

function defaultClip(){
  return {
    scale:100,posX:0,posY:0,rotation:0,opacity:1,
    crop:{top:0,bottom:0,left:0,right:0},
    color:{brightness:0,contrast:0,saturation:0,hue:0,gamma:1,vignette:0},
    volume:1, speed:1, reverse:false
  };
}

function setInspectorValues(c){
  const set=(id,v)=>{ const el=$('#'+id); if(el) el.value = v; };
  const setN=(id,v)=>{ const el=$('#'+id); if(el) el.value = v; };
  set('p-scale', c.scale); setN('p-scale-num', Math.round(c.scale));
  set('p-posx', c.posX);  setN('p-posx-num', Math.round(c.posX));
  set('p-posy', c.posY);  setN('p-posy-num', Math.round(c.posY));
  set('p-rot', c.rotation); setN('p-rot-num', Math.round(c.rotation));
  set('p-opacity', c.opacity*100); setN('p-opacity-num', Math.round(c.opacity*100));
  set('crop-top', c.crop.top); set('crop-bot', c.crop.bottom);
  set('crop-left', c.crop.left); set('crop-right', c.crop.right);
  set('p-volume', c.volume*100); setN('p-volume-num', Math.round(c.volume*100));
  set('c-brightness', c.color.brightness); setN('c-brightness-num', Math.round(c.color.brightness));
  set('c-contrast', c.color.contrast); setN('c-contrast-num', Math.round(c.color.contrast));
  set('c-saturation', c.color.saturation); setN('c-saturation-num', Math.round(c.color.saturation));
  set('c-hue', c.color.hue); setN('c-hue-num', Math.round(c.color.hue));
  set('c-gamma', c.color.gamma*100); setN('c-gamma-num', c.color.gamma.toFixed(2));
  set('c-vignette', c.color.vignette); setN('c-vignette-num', Math.round(c.color.vignette));
  set('p-speed', c.speed*100); setN('p-speed-num', c.speed.toFixed(2));
  const rev = $('#p-reverse'); if(rev) rev.checked = !!c.reverse;
  renderKeyframes();
}

function bindInspector(){
  const apply = (fn)=>()=>{
    const found = activeClip();
    if(!found){ return; }
    fn(found.clip);
    renderTimeline();
  };
  const link=(rid,nid,setter)=>{
    const r=$('#'+rid), n=$('#'+nid);
    if(!r||!n) return;
    r.addEventListener('input', ()=>{ n.value = r.value; apply(setter)(parseFloat(r.value)); });
    n.addEventListener('change', ()=>{ r.value = n.value; apply(setter)(parseFloat(n.value)); });
  };

  link('p-scale','p-scale-num', v=>c=>c.scale=v);
  link('p-posx','p-posx-num',  v=>c=>c.posX=v);
  link('p-posy','p-posy-num',  v=>c=>c.posY=v);
  link('p-rot','p-rot-num',    v=>c=>c.rotation=v);
  link('p-opacity','p-opacity-num', v=>c=>c.opacity=v/100);

  const cropLink=(id,key)=>{
    const el=$('#'+id);
    el.addEventListener('input', ()=>{
      const found=activeClip(); if(!found) return;
      found.clip.crop[key] = clamp(parseFloat(el.value)||0, 0, 49);
      renderTimeline();
    });
  };
  cropLink('crop-top','top'); cropLink('crop-bot','bottom');
  cropLink('crop-left','left'); cropLink('crop-right','right');

  link('p-volume','p-volume-num', v=>c=>c.volume=v/100);

  link('c-brightness','c-brightness-num', v=>c=>c.color.brightness=v);
  link('c-contrast','c-contrast-num',     v=>c=>c.color.contrast=v);
  link('c-saturation','c-saturation-num', v=>c=>c.color.saturation=v);
  link('c-hue','c-hue-num',               v=>c=>c.color.hue=v);
  link('c-gamma','c-gamma-num',           v=>c=>c.color.gamma=v/100);
  link('c-vignette','c-vignette-num',     v=>c=>c.color.vignette=v);

  link('p-speed','p-speed-num', v=>c=>{
    c.speed = clamp(v/100, 0.25, 4);
  });

  $('#p-reverse').addEventListener('change', e=>{
    const f=activeClip(); if(!f) return;
    f.clip.reverse = e.target.checked;
    renderTimeline();
  });

  $$('.speed-btn').forEach(b=>b.addEventListener('click',()=>{
    const sp = parseFloat(b.dataset.speed);
    const f = activeClip(); if(!f) return;
    f.clip.speed = sp;
    $('#p-speed').value = sp*100;
    $('#p-speed-num').value = sp.toFixed(2);
    $$('.speed-btn').forEach(x=>x.classList.toggle('active', x===b));
    renderTimeline();
  }));

  $('#p-blend').addEventListener('change', e=>{
    const f=activeClip(); if(!f) return;
    f.clip.blend = e.target.value;
  });

  // Keyframe buttons
  $('#kf-add').addEventListener('click', ()=>{
    const f=activeClip(); if(!f){ toast('Select a clip'); return; }
    f.clip.keyframes.push({
      time: state.currentTime - f.clip.start,
      props: {
        scale: f.clip.scale, posX: f.clip.posX, posY: f.clip.posY,
        rotation: f.clip.rotation, opacity: f.clip.opacity
      }
    });
    f.clip.keyframes.sort((a,b)=>a.time-b.time);
    pushHistory('add keyframe');
    renderKeyframes();
    toast('Keyframe added');
  });

  $$('.preset-btn').forEach(b=>b.addEventListener('click', ()=>{
    const f=activeClip(); if(!f){ toast('Select a clip'); return; }
    const end = f.clip.duration;
    let kfs = [];
    switch(b.dataset.preset){
      case 'fadeIn':  kfs=[{time:0,props:{opacity:0}},{time:Math.min(1,end),props:{opacity:1}}]; break;
      case 'fadeOut': kfs=[{time:Math.max(0,end-1),props:{opacity:1}},{time:end,props:{opacity:0}}]; break;
      case 'slideLeft': kfs=[{time:0,props:{posX:-50}},{time:Math.min(1,end),props:{posX:0}}]; break;
      case 'slideRight':kfs=[{time:0,props:{posX:50}},{time:Math.min(1,end),props:{posX:0}}]; break;
      case 'zoomIn':  kfs=[{time:0,props:{scale:50}},{time:Math.min(1,end),props:{scale:100}}]; break;
      case 'zoomOut': kfs=[{time:0,props:{scale:150}},{time:Math.min(1,end),props:{scale:100}}]; break;
      case 'spin':    kfs=[{time:0,props:{rotation:-180}},{time:Math.min(2,end),props:{rotation:180}}]; break;
      case 'bounce':  kfs=[{time:0,props:{posY:20}},{time:end*0.5,props:{posY:-10}},{time:end,props:{posY:0}}]; break;
    }
    // Merge into clip.keyframes but store as full snapshot
    const base = {scale:f.clip.scale,posX:f.clip.posX,posY:f.clip.posY,rotation:f.clip.rotation,opacity:f.clip.opacity};
    f.clip.keyframes = kfs.map(k=>({time:k.time, props:{...base, ...k.props}}));
    pushHistory('preset animation');
    renderKeyframes();
    toast('Applied preset: '+b.dataset.preset);
  }));
}

function renderKeyframes(){
  const list = $('#kf-list');
  if(!list) return;
  list.innerHTML = '';
  const f = activeClip();
  if(!f || !f.clip.keyframes.length){
    list.innerHTML = `<div class="kf-empty">No keyframes yet</div>`;
    return;
  }
  f.clip.keyframes.forEach((k,i)=>{
    const item = document.createElement('div');
    item.className='kf-item';
    item.innerHTML = `
      <span class="kf-time">@ ${fmtTime(k.time)}</span>
      <span class="kf-del" data-i="${i}">✕</span>
    `;
    item.querySelector('.kf-del').addEventListener('click', ()=>{
      f.clip.keyframes.splice(i,1);
      renderKeyframes();
      pushHistory('delete keyframe');
    });
    list.appendChild(item);
  });
}

/* ═══════════════════════════════════════════════════════════════
   LIBRARY PANELS — Titles / Transitions / Effects / Elements
   ═══════════════════════════════════════════════════════════════ */
const TITLES = [
  {icon:'T', name:'Basic Text', preset:'basic'},
  {icon:'T', name:'Lower Third', preset:'lower'},
  {icon:'T', name:'Title Card', preset:'title'},
  {icon:'T', name:'Subtitle', preset:'subtitle'},
  {icon:'T', name:'Callout', preset:'callout'},
  {icon:'T', name:'End Card', preset:'end'}
];
const TRANSITIONS = [
  {icon:'⇄', name:'Cross Dissolve', preset:'dissolve'},
  {icon:'▮', name:'Fade to Black', preset:'fadeblack'},
  {icon:'◀▶',name:'Push', preset:'push'},
  {icon:'⤡', name:'Wipe', preset:'wipe'},
  {icon:'◎', name:'Zoom', preset:'zoom'},
  {icon:'✱', name:'Spin', preset:'spin'}
];
const EFFECTS = [
  {icon:'🎬', name:'Cinematic', key:'cinematic'},
  {icon:'⚫', name:'Black & White', key:'bw'},
  {icon:'📼', name:'VHS Retro', key:'vhs'},
  {icon:'⚡', name:'Glitch', key:'glitch'},
  {icon:'🌈', name:'RGB Shift', key:'rgbshift'},
  {icon:'🟤', name:'Sepia', key:'sepia'},
  {icon:'🎨', name:'Duotone', key:'duotone'},
  {icon:'🔳', name:'Posterize', key:'posterize'},
  {icon:'🔄', name:'Invert', key:'invert'},
  {icon:'▦', name:'Pixelate', key:'pixelate'},
  {icon:'✨', name:'Dream Glow', key:'dreamglow'},
  {icon:'—', name:'None', key:'none'}
];
const ELEMENTS = [
  {icon:'◯', name:'Circle'},
  {icon:'▭', name:'Rectangle'},
  {icon:'△', name:'Triangle'},
  {icon:'★', name:'Star'},
  {icon:'♥', name:'Heart'},
  {icon:'▶', name:'Play Button'}
];

function buildTile(container, list, onDrop){
  container.innerHTML = '';
  list.forEach(it=>{
    const el = document.createElement('div');
    el.className = 'tile';
    el.draggable = !!onDrop;
    el.innerHTML = `<span class="tile-icon">${it.icon}</span><span class="tile-name">${it.name}</span>`;
    if(onDrop){
      el.addEventListener('dragstart', e=>{
        e.dataTransfer.setData('text/xcut-tile', JSON.stringify(it));
        e.dataTransfer.effectAllowed = 'copy';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', ()=>el.classList.remove('dragging'));
      el.addEventListener('dblclick', ()=>onDrop(it));
    }
    container.appendChild(el);
  });
}

function installTileDrops(){
  // Drop onto a video track => adds title/effect/transition
  $$('.track-lane').forEach(lane=>{
    lane.addEventListener('dragover', e=>{
      if(e.dataTransfer.types.includes('text/xcut-tile') || e.dataTransfer.types.includes('text/xcut-media')){
        e.preventDefault();
        e.dataTransfer.dropEffect='copy';
      }
    });
    lane.addEventListener('drop', e=>{
      e.preventDefault();
      const tileStr = e.dataTransfer.getData('text/xcut-tile');
      const mediaId = e.dataTransfer.getData('text/xcut-media');
      const track = lane.dataset.track;
      const rect = lane.getBoundingClientRect();
      const dropTime = Math.max(0, (e.clientX - rect.left) / state.pxPerSec);
      if(mediaId){
        const item = state.media.find(m=>m.id===mediaId);
        if(item) addMediaToTimeline(item, track);
        return;
      }
      if(tileStr){
        const tile = JSON.parse(tileStr);
        addTileToTimeline(tile, track, dropTime);
      }
    });
  });
}

function addTileToTimeline(tile, track, time){
  if(tile.key !== undefined){
    // effect — apply to clip at that time
    const c = state.tracks[track].clips.find(c => time>=c.start && time<c.start+c.duration);
    if(c){
      c.effect = tile.key;
      state.selectedClipId = c.id;
      renderTimeline();
      updateInspector();
      toast('Effect applied: '+tile.name);
    } else {
      toast('Drop an effect onto a clip');
    }
    return;
  }
  if(tile.preset && TRANSITIONS.find(x=>x.preset===tile.preset)){
    // transition — apply between clips
    const clips = state.tracks[track].clips.slice().sort((a,b)=>a.start-b.start);
    const idx = clips.findIndex(c => Math.abs((c.start+c.duration) - time) < 0.5);
    if(idx>=0 && clips[idx+1]){
      clips[idx].transitionOut = tile.preset;
      clips[idx+1].transitionIn = tile.preset;
      renderTimeline();
      toast('Transition: '+tile.name);
    } else {
      toast('Drop transition between two clips');
    }
    return;
  }
  if(tile.preset){
    // title
    const clip = {
      id: uid(),
      mediaId: null,
      name: tile.name,
      kind: 'text',
      start: time,
      duration: 3,
      srcIn: 0, srcOut: 3,
      text: 'Your text',
      fontSize: 42,
      fontFamily: 'Inter,sans-serif',
      color: '#ffffff',
      posX: 0, posY: 0,
      scale:100, rotation:0, opacity:1,
      crop:{top:0,bottom:0,left:0,right:0},
      colorAdj:{brightness:0,contrast:0,saturation:0,hue:0,gamma:1,vignette:0},
      effect:'none',
      keyframes: [],
      speed:1
    };
    state.tracks[track].clips.push(clip);
    state.tracks[track].clips.sort((a,b)=>a.start-b.start);
    state.selectedClipId = clip.id;
    computeDuration();
    pushHistory('add title');
    renderTimeline(); renderRuler(); updateInspector();
    toast('Added: '+tile.name);
  }
}

/* ═══════════════════════════════════════════════════════════════
   TOOLBAR + TRANSPORT EVENTS
   ═══════════════════════════════════════════════════════════════ */
$('#tp-play').addEventListener('click', ()=>{
  if(state.duration<=0){ toast('Timeline is empty'); return; }
  if(!state.playing && state.currentTime>=state.duration) state.currentTime=0;
  setPlaying(!state.playing);
});
$('#tp-start').addEventListener('click', ()=>{ state.currentTime=0; positionPlayhead(); seekVideo(0); updateTimeReadout(); });
$('#tp-end').addEventListener('click', ()=>{ state.currentTime=state.duration; positionPlayhead(); seekVideo(state.duration); updateTimeReadout(); });
$('#tp-prev-frame').addEventListener('click', ()=>{ state.currentTime=Math.max(0,state.currentTime-1/state.fps); positionPlayhead(); seekVideo(state.currentTime); updateTimeReadout(); });
$('#tp-next-frame').addEventListener('click', ()=>{ state.currentTime=Math.min(state.duration,state.currentTime+1/state.fps); positionPlayhead(); seekVideo(state.currentTime); updateTimeReadout(); });

$$('.tl-tool[data-tool]').forEach(b=>b.addEventListener('click', ()=>{
  state.tool = b.dataset.tool;
  $$('.tl-tool[data-tool]').forEach(x=>x.classList.toggle('active', x===b));
}));
$('#tl-snap').addEventListener('click', ()=>{
  state.snapping = !state.snapping;
  $('#tl-snap').classList.toggle('active', state.snapping);
  toast(state.snapping?'Snapping on':'Snapping off');
});

$('#tl-zoom').addEventListener('input', e=>{
  state.pxPerSec = parseFloat(e.target.value);
  renderTimeline();
  renderRuler();
  positionPlayhead();
});
$('#tl-zoom-in').addEventListener('click', ()=>{
  $('#tl-zoom').value = Math.min(400, parseFloat($('#tl-zoom').value)+20);
  $('#tl-zoom').dispatchEvent(new Event('input'));
});
$('#tl-zoom-out').addEventListener('click', ()=>{
  $('#tl-zoom').value = Math.max(10, parseFloat($('#tl-zoom').value)-20);
  $('#tl-zoom').dispatchEvent(new Event('input'));
});

/* Track header buttons */
$$('.track-header').forEach(header=>{
  header.querySelectorAll('.tc-btn').forEach(btn=>btn.addEventListener('click', ()=>{
    const track = header.dataset.track;
    const act = btn.dataset.act;
    const t = state.tracks[track];
    if(!t) return;
    if(act==='mute'){ t.muted = !t.muted; btn.classList.toggle('on', t.muted); }
    else if(act==='solo'){ t.solo = !t.solo; btn.classList.toggle('on', t.solo); }
    else if(act==='lock'){ t.locked = !t.locked; btn.classList.toggle('on', t.locked); }
    else if(act==='hide'){ t.hidden = !t.hidden; btn.classList.toggle('on', t.hidden); }
  }));
});

/* ═══════════════════════════════════════════════════════════════
   LIBRARY TABS
   ═══════════════════════════════════════════════════════════════ */
$$('.lib-tab').forEach(b=>b.addEventListener('click', ()=>{
  state.activeLib = b.dataset.lib;
  $$('.lib-tab').forEach(x=>x.classList.toggle('active', x===b));
  $$('.lib-panel').forEach(p=>p.classList.toggle('active', p.dataset.panel===state.activeLib));
}));

/* Inspector tabs */
$$('.insp-tab').forEach(b=>b.addEventListener('click', ()=>{
  state.activeInsp = b.dataset.insp;
  $$('.insp-tab').forEach(x=>x.classList.toggle('active', x===b));
  $$('.insp-panel').forEach(p=>p.classList.toggle('active', p.dataset.panel===state.activeInsp));
}));

/* ═══════════════════════════════════════════════════════════════
   TOP BAR / FILE INPUT / DRAG-DROP
   ═══════════════════════════════════════════════════════════════ */
const fileInput = $('#file-input');
$('#lib-import').addEventListener('click', ()=>fileInput.click());
$('#audio-import').addEventListener('click', ()=>fileInput.click());
fileInput.addEventListener('change', e=>{
  handleFiles(e.target.files);
  e.target.value='';
});

// Drag files into whole window
window.addEventListener('dragover', e=>{
  if(e.dataTransfer.types.includes('Files')) e.preventDefault();
});
window.addEventListener('drop', e=>{
  if(e.dataTransfer.files && e.dataTransfer.files.length){
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  }
});

/* Undo / redo buttons */
$('#btn-undo').addEventListener('click', undo);
$('#btn-redo').addEventListener('click', redo);

/* Split clip at playhead */
$('#btn-split').addEventListener('click', ()=>{
  const found = activeClip();
  if(!found){ toast('Select a clip first'); return; }
  const c = found.clip;
  const local = state.currentTime - c.start;
  if(local<=0.05 || local>=c.duration-0.05){ toast('Playhead not over clip'); return; }
  const right = JSON.parse(JSON.stringify(c));
  right.id = uid();
  right.start = state.currentTime;
  right.duration = c.duration - local;
  right.srcIn = c.srcIn + local * c.speed;
  right.srcOut = c.srcOut;
  c.duration = local;
  c.srcOut = c.srcIn + local * c.speed;
  const arr = state.tracks[found.track].clips;
  arr.push(right);
  arr.sort((a,b)=>a.start-b.start);
  computeDuration();
  pushHistory('split clip');
  renderTimeline(); renderRuler();
  toast('Split at playhead');
});

/* Delete selected clip */
$('#btn-delete').addEventListener('click', ()=>{
  const found = activeClip();
  if(!found){ toast('No clip selected'); return; }
  const arr = state.tracks[found.track].clips;
  const i = arr.indexOf(found.clip);
  if(i>=0) arr.splice(i,1);
  state.selectedClipId = null;
  computeDuration();
  pushHistory('delete clip');
  renderTimeline(); renderRuler(); updateInspector();
});

/* ═══════════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════════════════════ */
window.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT' || e.target.tagName==='SELECT') return;
  const k = e.key.toLowerCase();
  if(e.code==='Space'){ e.preventDefault(); $('#tp-play').click(); }
  else if(k==='v'){ $$('.tl-tool[data-tool="select"]')[0].click(); }
  else if(k==='c'){ $$('.tl-tool[data-tool="razor"]')[0].click(); }
  else if(e.key==='Delete'||e.key==='Backspace'){ $('#btn-delete').click(); }
  else if(e.key==='ArrowLeft'){ e.preventDefault(); state.currentTime=Math.max(0,state.currentTime-1/state.fps); positionPlayhead(); updateTimeReadout(); }
  else if(e.key==='ArrowRight'){ e.preventDefault(); state.currentTime=Math.min(state.duration,state.currentTime+1/state.fps); positionPlayhead(); updateTimeReadout(); }
  else if(e.ctrlKey && k==='z'){ e.preventDefault(); undo(); }
  else if(e.ctrlKey && k==='y'){ e.preventDefault(); redo(); }
  else if(e.ctrlKey && k==='b'){ e.preventDefault(); $('#btn-split').click(); }
  else if(e.ctrlKey && k==='s'){ e.preventDefault(); saveProject(); }
});

/* ═══════════════════════════════════════════════════════════════
   SAVE / LOAD PROJECT (.xcut JSON)
   ═══════════════════════════════════════════════════════════════ */
function saveProject(){
  const data = {
    version: 1,
    projectName: 'xcut-project',
    savedAt: new Date().toISOString(),
    media: state.media.map(m=>({id:m.id,name:m.name,kind:m.kind,size:m.size,width:m.width,height:m.height,duration:m.duration})),
    tracks: state.tracks,
    duration: state.duration
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'xcut-project.xcut.json';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);
  toast('Project saved');
}
$('#btn-save').addEventListener('click', saveProject);

/* ═══════════════════════════════════════════════════════════════
   MODAL HELPERS
   ═══════════════════════════════════════════════════════════════ */
function openModal(title, bodyHTML, footerHTML){
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = bodyHTML;
  $('#modal-foot').innerHTML = footerHTML||'';
  $('#modal').classList.add('show');
}
function closeModal(){ $('#modal').classList.remove('show'); }
$('#modal-close').addEventListener('click', closeModal);
$('#modal').addEventListener('click', e=>{ if(e.target===$('#modal')) closeModal(); });

/* ═══════════════════════════════════════════════════════════════
   EXPORT (WebM via MediaRecorder)
   ═══════════════════════════════════════════════════════════════ */
$('#btn-export-top').addEventListener('click', doExport);

async function doExport(){
  if(state.duration<=0){ toast('Timeline is empty'); return; }
  openModal('Export', `
    <p>Rendering your project…</p>
    <div class="progress-track"><div class="progress-fill" id="exp-fill"></div></div>
    <p id="exp-pct" style="text-align:center;font-family:var(--mono);color:var(--accent)">0%</p>
    <p style="color:var(--text-2);font-size:11px;margin-top:10px">This exports the preview canvas (including effects) as WebM. Audio is mixed from active video clips.</p>
  `);
  const fill = $('#exp-fill');
  const pct  = $('#exp-pct');

  // Set up streams
  const canvasStream = canvas.captureStream(30);
  const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
  const dest = audioCtx.createMediaStreamDestination();

  // Simple audio mixing: connect each video pool element via gain
  const gains = new Map();
  for(const [id,v] of videoPool){
    try{
      const src = audioCtx.createMediaElementSource(v);
      const g = audioCtx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(dest);
      gains.set(id, g);
    }catch(e){ /* already connected */ }
  }

  const stream = new MediaStream();
  canvasStream.getVideoTracks().forEach(t=>stream.addTrack(t));
  dest.stream.getAudioTracks().forEach(t=>stream.addTrack(t));

  let mime = 'video/webm;codecs=vp9,opus';
  if(!MediaRecorder.isTypeSupported(mime)) mime='video/webm;codecs=vp8,opus';
  if(!MediaRecorder.isTypeSupported(mime)) mime='video/webm';

  const rec = new MediaRecorder(stream, {mimeType:mime, videoBitsPerSecond:6_000_000});
  const chunks = [];
  rec.ondataavailable = e=>{ if(e.data.size) chunks.push(e.data); };
  const done = new Promise(r=>rec.onstop=r);

  // Reset playhead & play
  state.currentTime = 0;
  positionPlayhead();
  setPlaying(true);
  rec.start();

  const total = state.duration;
  const t0 = now();
  const progressTimer = setInterval(()=>{
    const p = clamp(state.currentTime/total, 0, 1);
    fill.style.width = (p*100).toFixed(0)+'%';
    pct.textContent = (p*100).toFixed(0)+'%';
    // update gains for active clips
    for(const [id,g] of gains){
      let vol = 0;
      // find any clip on audio track using this media
      for(const tn of ['V1','V2','A1','A2']){
        for(const c of state.tracks[tn].clips){
          if(c.mediaId===id && state.currentTime>=c.start && state.currentTime<c.start+c.duration){
            if(!state.tracks[tn].muted){
              // fade in/out
              const local = state.currentTime - c.start;
              let f = 1;
              if(c.audioFadeIn) f *= Math.min(1, local/c.audioFadeIn);
              if(c.audioFadeOut) f *= Math.min(1, (c.duration-local)/c.audioFadeOut);
              vol = Math.max(vol, c.volume * f);
            }
          }
        }
      }
      g.gain.value = vol;
    }
    if(!state.playing){
      clearInterval(progressTimer);
      setTimeout(()=>rec.stop(), 250);
    }
  }, 100);

  await done;
  clearInterval(progressTimer);

  const blob = new Blob(chunks, {type:mime});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'xcut-export.webm';
  a.click();
  setTimeout(()=>URL.revokeObjectURL(url), 5000);

  closeModal();
  toast('Export complete ✓');
}

/* ═══════════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════════ */
function boot(){
  // Build library panels
  buildTile($('#titles-grid'), TITLES, (it)=>addTileToTimeline(it, 'V2', state.currentTime));
  buildTile($('#transitions-grid'), TRANSITIONS, (it)=>toast('Drag a transition between two clips'));
  buildTile($('#effects-grid'), EFFECTS, (it)=>{ /* drag to apply */ });
  buildTile($('#elements-grid'), ELEMENTS, (it)=>toast('Elements: '+(it.name)));

  installTileDrops();
  bindInspector();

  renderMediaGrid();
  renderTimeline();
  renderRuler();
  updateInspector();
  updateTimeReadout();
  positionPlayhead();

  renderFrame();
  toast('X-CUT Studio ready — import media to begin');
}
boot();

})();