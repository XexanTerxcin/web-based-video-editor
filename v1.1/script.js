(function(){
"use strict";

/* =========================================================
   X-CUT — single-file browser video editor
   WebGL-based real-time effect pipeline + Canvas overlay
   compositing + MediaRecorder export.
   ========================================================= */

const $ = (sel, root) => (root||document).querySelector(sel);
const $$ = (sel, root) => Array.from((root||document).querySelectorAll(sel));

/* ---------------- Toast ---------------- */
let toastTimer=null;
function toast(msg){
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.remove('show'), 2200);
}

/* ---------------- State ---------------- */
const state = {
  videoLoaded:false,
  playing:false,
  duration:0,
  trimIn:0,
  trimOut:0,
  activeFx:'none',
  fxIntensity:1,
  adjust:{brightness:0, contrast:0, saturation:0, hue:0, gamma:1, sharpen:0, vignette:0, grain:0, speed:1, volume:1},
  transform:{scale:100, posX:0, posY:0, rotation:0},
  crop:{top:0, bottom:0, left:0, right:0},
  markers:[],           // {id, time}
  keyframes:[],         // {id, time, transform:{...}, crop:{...}, adjust:{...}}
  activeKeyframeId:null,
  texts:[],
  selectedTextId:null,
  dragging:null,
  mediaLibrary:[],
  activeMediaId:null,
  replaceMediaPending:false,
  timelineClip:null,
  trimMode:'trim',
  media:{
    fileName:'',
    fileType:'',
    fileSize:0,
    width:0,
    height:0,
    duration:0,
    status:'No media loaded'
  }
};

/* ---------------- Video element (hidden, source of truth) ---------------- */
const video = document.createElement('video');
video.playsInline = true;
video.crossOrigin = 'anonymous';
video.muted = false;
const mediaPreview = $('#media-preview-video');
mediaPreview.muted = true;
mediaPreview.addEventListener('timeupdate', ()=>{
  $('#media-preview-time').textContent = `${fmtTime(mediaPreview.currentTime)} / ${fmtTime(mediaPreview.duration)}`;
});
mediaPreview.addEventListener('play', ()=>{ $('#btn-media-preview-play').textContent = '❚❚'; });
mediaPreview.addEventListener('pause', ()=>{ $('#btn-media-preview-play').textContent = '▶'; });

/* ---------------- WebGL setup ---------------- */
const canvas = $('#glcanvas');
const gl = canvas.getContext('webgl', {preserveDrawingBuffer:true, alpha:false}) ||
           canvas.getContext('experimental-webgl', {preserveDrawingBuffer:true});

const VERT_SRC = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){
  vUv = (aPos + 1.0) * 0.5;
  vUv.y = 1.0 - vUv.y;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `
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
uniform float uSharpen;
uniform float uVignette;
uniform float uGrain;

uniform int uFx;
uniform float uFxAmt;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uRotation;
uniform vec4 uCrop;   // left, right, top, bottom (0..0.49 each)

vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0*d+e)), d / (q.x+e), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
float rand(vec2 co){ return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453); }

vec3 sampleTex(vec2 uv){ return texture2D(uTex, clamp(uv,0.0,1.0)).rgb; }

void main(){
  vec2 uv = vUv;

  /* ---- crop: remap uv into the cropped rect ---- */
  float cL = uCrop.x, cR = uCrop.y, cT = uCrop.z, cB = uCrop.w;
  vec2 size = vec2(1.0 - cL - cR, 1.0 - cT - cB);
  uv = vec2((uv.x - cL) / size.x, (uv.y - cT) / size.y);

  /* ---- rotation around center ---- */
  float s = sin(uRotation), c = cos(uRotation);
  vec2 p = uv - 0.5;
  uv = vec2(p.x*c - p.y*s, p.x*s + p.y*c) + 0.5;

  /* ---- scale + position ---- */
  uv = (uv - 0.5) / uScale + 0.5 + uOffset;

  /* if outside [0,1], fade to black */
  float inBounds = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);

  vec3 col = sampleTex(uv) * inBounds;

  /* ---- stylistic FX pass (uFx) ---- */
  if(uFx == 1){ /* Cinematic teal-orange */
    vec3 hsv = rgb2hsv(col);
    col = mix(col, hsv2rgb(vec3(mod(hsv.x + (hsv.z>0.5?0.02:-0.06),1.0), hsv.y*1.15, hsv.z)), uFxAmt);
    col = mix(col, col*vec3(1.05,0.98,0.92)+vec3(0.0,0.0,0.03), uFxAmt);
  } else if(uFx == 2){ /* Noir B&W */
    float g = dot(col, vec3(0.299,0.587,0.114));
    g = pow(g, 0.9);
    col = mix(col, vec3(g), uFxAmt);
  } else if(uFx == 3){ /* VHS */
    float sh = sin(uv.y*800.0)*0.02*uFxAmt;
    vec2 uvr = uv + vec2(0.004*uFxAmt+sh,0.0);
    vec2 uvb = uv - vec2(0.004*uFxAmt+sh,0.0);
    col = vec3(sampleTex(uvr).r, sampleTex(uv).g, sampleTex(uvb).b);
    float n = (rand(uv*uTime)-0.5)*0.15*uFxAmt;
    col += n;
    col *= 1.0 - 0.15*uFxAmt*abs(sin(uv.y*60.0+uTime*4.0));
  } else if(uFx == 4){ /* Glitch */
    float block = floor(uv.y*24.0);
    float jitter = (rand(vec2(block, floor(uTime*8.0)))-0.5) * 0.08 * uFxAmt;
    vec2 uv2 = vec2(uv.x + jitter, uv.y);
    col = vec3(sampleTex(uv2+vec2(0.01*uFxAmt,0.0)).r, sampleTex(uv2).g, sampleTex(uv2-vec2(0.01*uFxAmt,0.0)).b);
  } else if(uFx == 5){ /* RGB shift */
    float amt = 0.008*uFxAmt;
    col = vec3(sampleTex(uv+vec2(amt,0.0)).r, sampleTex(uv).g, sampleTex(uv-vec2(amt,0.0)).b);
  } else if(uFx == 6){ /* Sepia */
    vec3 sep = vec3(dot(col, vec3(0.393,0.769,0.189)), dot(col, vec3(0.349,0.686,0.168)), dot(col, vec3(0.272,0.534,0.131)));
    col = mix(col, sep, uFxAmt);
  } else if(uFx == 7){ /* Duotone (cyan/magenta) */
    float g = dot(col, vec3(0.299,0.587,0.114));
    vec3 shadow = vec3(0.05,0.0,0.2);
    vec3 hi = vec3(1.0,0.55,0.9);
    col = mix(col, mix(shadow, hi, g), uFxAmt);
  } else if(uFx == 8){ /* Posterize */
    float levels = mix(64.0, 5.0, uFxAmt);
    col = floor(col*levels)/levels;
  } else if(uFx == 9){ /* Invert */
    col = mix(col, 1.0-col, uFxAmt);
  } else if(uFx == 10){ /* Pixelate */
    float px = mix(1.0, 80.0, uFxAmt);
    vec2 uvp = floor(uv*px)/px;
    col = sampleTex(uvp);
  } else if(uFx == 11){ /* Dream glow / bloom-ish */
    vec3 blur = vec3(0.0);
    float total=0.0;
    for(int x=-2;x<=2;x++){
      for(int y=-2;y<=2;y++){
        vec2 off = vec2(float(x),float(y))*0.004;
        float w = 1.0;
        blur += sampleTex(uv+off)*w; total+=w;
      }
    }
    blur/=total;
    vec3 bloom = max(blur - 0.55, 0.0)*2.0;
    col = col + bloom*uFxAmt;
  } else if(uFx == 12){ /* Thermal */
    float g = dot(col, vec3(0.299,0.587,0.114));
    vec3 thermal = hsv2rgb(vec3(0.66*(1.0-g), 1.0, 1.0));
    col = mix(col, thermal, uFxAmt);
  } else if(uFx == 13){ /* Cross-process */
    vec3 hsv = rgb2hsv(col);
    hsv.x = mod(hsv.x+0.08,1.0);
    hsv.y = clamp(hsv.y*1.3,0.0,1.0);
    vec3 cc = hsv2rgb(hsv);
    cc = pow(cc, vec3(0.9,1.05,1.15));
    col = mix(col, cc, uFxAmt);
  } else if(uFx == 14){ /* Edge detect */
    float tx = 1.0/uRes.x, ty = 1.0/uRes.y;
    vec3 s00=sampleTex(uv+vec2(-tx,-ty)), s10=sampleTex(uv+vec2(0.0,-ty)), s20=sampleTex(uv+vec2(tx,-ty));
    vec3 s01=sampleTex(uv+vec2(-tx,0.0)), s21=sampleTex(uv+vec2(tx,0.0));
    vec3 s02=sampleTex(uv+vec2(-tx,ty)), s12=sampleTex(uv+vec2(0.0,ty)), s22=sampleTex(uv+vec2(tx,ty));
    vec3 gx = -s00-2.0*s01-s02+s20+2.0*s21+s22;
    vec3 gy = -s00-2.0*s10-s20+s02+2.0*s12+s22;
    vec3 edge = sqrt(gx*gx+gy*gy);
    col = mix(col, edge, uFxAmt);
  } else if(uFx == 15){ /* Old film */
    float g = dot(col, vec3(0.299,0.587,0.114));
    g = pow(g,0.85);
    vec3 tint = vec3(g)*vec3(0.95,0.9,0.75);
    float scratch = step(0.996, rand(vec2(uv.x*3.0, uTime*10.0)));
    float flick = 0.9+0.1*rand(vec2(uTime));
    tint = tint*flick + scratch*0.3;
    col = mix(col, tint, uFxAmt);
  } else if(uFx == 16){ /* Neon high-contrast */
    vec3 hsv = rgb2hsv(col);
    hsv.y = clamp(hsv.y*1.6,0.0,1.0);
    hsv.z = pow(hsv.z, 0.8);
    col = mix(col, hsv2rgb(hsv), uFxAmt);
  } else if(uFx == 17){ /* Frost / blur dreamy */
    vec3 blur = vec3(0.0); float tot=0.0;
    for(int x=-3;x<=3;x++){ for(int y=-3;y<=3;y++){
      vec2 off = vec2(float(x),float(y))*0.006;
      blur += sampleTex(uv+off); tot+=1.0;
    }}
    blur/=tot;
    col = mix(col, blur, uFxAmt);
  } else if(uFx == 18){ /* Chromatic zoom blur */
    vec3 acc = vec3(0.0); float tot=0.0;
    for(int i=0;i<8;i++){
      float t = float(i)/8.0;
      vec2 uvz = mix(uv, vec2(0.5), t*0.06*uFxAmt);
      acc += sampleTex(uvz); tot+=1.0;
    }
    col = acc/tot;
  }

  /* ---- basic adjustments ---- */
  col = col + uBrightness;
  col = (col - 0.5) * (1.0 + uContrast) + 0.5;
  float lum = dot(col, vec3(0.299,0.587,0.114));
  col = mix(vec3(lum), col, 1.0 + uSaturation);
  vec3 hsvc = rgb2hsv(clamp(col,0.0,1.0));
  hsvc.x = mod(hsvc.x + uHue/360.0, 1.0);
  col = hsv2rgb(hsvc);
  col = pow(clamp(col,0.0001,1.0), vec3(1.0/uGamma));

  /* sharpen (simple unsharp mask) */
  if(uSharpen > 0.001){
    float tx = 1.0/uRes.x, ty=1.0/uRes.y;
    vec3 blurS = (sampleTex(uv+vec2(tx,0.0))+sampleTex(uv-vec2(tx,0.0))+sampleTex(uv+vec2(0.0,ty))+sampleTex(uv-vec2(0.0,ty)))*0.25;
    col += (col - blurS) * uSharpen * 2.0;
  }

  /* vignette */
  if(uVignette > 0.001){
    float d = distance(uv, vec2(0.5));
    float v = smoothstep(0.9, 0.25, d);
    col *= mix(1.0, v, uVignette);
  }

  /* grain */
  if(uGrain > 0.001){
    float n = (rand(uv*uTime*60.0)-0.5) * uGrain * 0.35;
    col += n;
  }

  gl_FragColor = vec4(clamp(col,0.0,1.0), 1.0);
}`;

function compileShader(src, type){
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if(!gl.getShaderParameter(sh, gl.COMPILE_STATUS)){
    console.error(gl.getShaderInfoLog(sh));
  }
  return sh;
}
const prog = gl.createProgram();
gl.attachShader(prog, compileShader(VERT_SRC, gl.VERTEX_SHADER));
gl.attachShader(prog, compileShader(FRAG_SRC, gl.FRAGMENT_SHADER));
gl.linkProgram(prog);
gl.useProgram(prog);

const quad = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

const U = {};
['uTex','uTime','uRes','uBrightness','uContrast','uSaturation','uHue','uGamma','uSharpen','uVignette','uGrain','uFx','uFxAmt','uScale','uOffset','uRotation','uCrop']
  .forEach(name => U[name] = gl.getUniformLocation(prog, name));

const FX_MAP = {
  none:0, cinematic:1, noir:2, vhs:3, glitch:4, rgbshift:5, sepia:6, duotone:7,
  posterize:8, invert:9, pixelate:10, dreamglow:11, thermal:12, crossprocess:13,
  edge:14, oldfilm:15, neon:16, frost:17, zoomblur:18
};

const FX_LIST = [
  {key:'none', name:'No effect', icon:'—'},
  {key:'cinematic', name:'Cinematic tilt-shift', icon:'🎬'},
  {key:'noir', name:'Noir B&W', icon:'⚫'},
  {key:'vhs', name:'VHS retro', icon:'📼'},
  {key:'glitch', name:'Glitch', icon:'⚡'},
  {key:'rgbshift', name:'RGB shift', icon:'🌈'},
  {key:'sepia', name:'Sepia', icon:'🟤'},
  {key:'duotone', name:'Duotone', icon:'🎨'},
  {key:'posterize', name:'Posterize', icon:'🔳'},
  {key:'invert', name:'Invert', icon:'🔄'},
  {key:'pixelate', name:'Pixelate', icon:'▦'},
  {key:'dreamglow', name:'Dream glow', icon:'✨'},
  {key:'thermal', name:'Thermal', icon:'🌡️'},
  {key:'crossprocess', name:'Cross-process', icon:'🧪'},
  {key:'edge', name:'Edge detect', icon:'▨'},
  {key:'oldfilm', name:'Old film', icon:'🎞️'},
  {key:'neon', name:'Neon pop', icon:'💡'},
  {key:'frost', name:'Frost blur', icon:'❄️'},
  {key:'zoomblur', name:'Zoom blur', icon:'🌀'},
];

/* Build FX grid UI */
const fxGrid = $('#fx-grid');
FX_LIST.forEach(fx=>{
  const card = document.createElement('div');
  card.className = 'fx-card' + (fx.key==='none' ? ' active' : '');
  card.dataset.key = fx.key;
  card.innerHTML = `<div class="fx-icon">${fx.icon}</div><div class="fx-name">${fx.name}</div>`;
  card.addEventListener('click', ()=>{
    $$('.fx-card').forEach(c=>c.classList.remove('active'));
    card.classList.add('active');
    state.activeFx = fx.key;
    $('#hud-fx').textContent = fx.key==='none' ? 'No effect' : fx.name;
  });
  fxGrid.appendChild(card);
});

function lerp(a,b,t){ return a + (b-a)*t; }
function lerpObj(a,b,t){
  const out = {};
  for(const k in a) out[k] = lerp(a[k], b[k], t);
  return out;
}
function getInterpolatedState(){
  const kfs = state.keyframes.slice().sort((x,y)=>x.time-y.time);
  if(kfs.length === 0) return null;
  const t = video.currentTime;
  if(t <= kfs[0].time) return kfs[0];
  if(t >= kfs[kfs.length-1].time) return kfs[kfs.length-1];
  for(let i=0;i<kfs.length-1;i++){
    const a = kfs[i], b = kfs[i+1];
    if(t >= a.time && t <= b.time){
      const f = (t - a.time) / (b.time - a.time);
      return {
        transform: lerpObj(a.transform, b.transform, f),
        crop: lerpObj(a.crop, b.crop, f),
        adjust: lerpObj(a.adjust, b.adjust, f)
      };
    }
  }
  return kfs[0];
}
/* ---------------- Render loop ---------------- */
let startTimeRef = performance.now();
function render(){
  requestAnimationFrame(render);
  if(!state.videoLoaded) return;

  if(video.readyState >= video.HAVE_CURRENT_DATA){
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  gl.viewport(0,0,canvas.width, canvas.height);
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  gl.uniform1i(U.uTex, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.uniform1f(U.uTime, (performance.now()-startTimeRef)/1000);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);

const kf = getInterpolatedState();
const tr = kf ? kf.transform : state.transform;
const cr = kf ? kf.crop      : state.crop;
const ad = kf ? kf.adjust    : state.adjust;

gl.uniform1f(U.uBrightness, ad.brightness/100 * 0.6);
gl.uniform1f(U.uContrast,   ad.contrast/100);
gl.uniform1f(U.uSaturation, ad.saturation/100);
gl.uniform1f(U.uHue,        ad.hue);
gl.uniform1f(U.uGamma,      ad.gamma);
gl.uniform1f(U.uSharpen,    ad.sharpen/100);
gl.uniform1f(U.uVignette,   ad.vignette/100);
gl.uniform1f(U.uGrain,      ad.grain/100);
gl.uniform1i(U.uFx,         FX_MAP[state.activeFx] || 0);
gl.uniform1f(U.uFxAmt,      state.fxIntensity);

gl.uniform2f(U.uScale, tr.scale/100, tr.scale/100);
gl.uniform2f(U.uOffset, tr.posX/100, tr.posY/100);
gl.uniform1f(U.uRotation, tr.rotation * Math.PI/180);
gl.uniform4f(U.uCrop, cr.left/100, cr.right/100, cr.top/100, cr.bottom/100);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  updateTimeUI();
  // update keyframe diamonds active state when playhead crosses them
if(state.videoLoaded && state.keyframes.length){
  const active = state.keyframes.find(k => Math.abs(k.time - video.currentTime) < 0.05);
  if(active && active.id !== state.activeKeyframeId){
    state.activeKeyframeId = active.id;
    $$('.track-keyframe').forEach((d,i)=>{
      d.classList.toggle('active', i === state.keyframes.findIndex(k=>k.id===active.id));
    });
  }
}
  syncTrimClamp();
}
render();

/* ---------------- File loading ---------------- */
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');

function formatBytes(bytes){
  if(!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units=['B','KB','MB','GB'];
  const idx = Math.min(Math.floor(Math.log(bytes)/Math.log(1024)), units.length-1);
  const value = bytes / (1024 ** idx);
  return `${value >= 10 || idx === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[idx]}`;
}

function getMediaKind(file){
  const type = (file && file.type) || '';
  if(type.startsWith('video/')) return 'video';
  if(type.startsWith('audio/')) return 'audio';
  if(type.startsWith('image/')) return 'image';
  const ext = (file && file.name && file.name.split('.').pop().toLowerCase()) || '';
  if(['mp4','webm','mov','m4v','avi','mkv'].includes(ext)) return 'video';
  if(['mp3','wav','aac','flac','ogg'].includes(ext)) return 'audio';
  if(['png','jpg','jpeg','gif','webp','bmp'].includes(ext)) return 'image';
  return 'file';
}

function getMediaIcon(kind){
  return {video:'🎬', audio:'🎵', image:'🖼️', file:'📁'}[kind] || '📁';
}

function updateMediaUI(){
  const item = state.mediaLibrary.find(m => m.id === state.activeMediaId) || state.mediaLibrary[0] || null;
  const count = state.mediaLibrary.length;
  $('#media-count').textContent = `${count} item${count === 1 ? '' : 's'}`;
  $('#media-status').textContent = item ? `${item.name} selected` : 'No media loaded';
  $('#media-empty-state').classList.toggle('hidden', count > 0);
  $('#media-name').textContent = item ? item.name : '—';
  $('#media-type').textContent = item ? item.typeLabel : '—';
  $('#media-size').textContent = item ? formatBytes(item.size) : '—';
  $('#media-resolution').textContent = item && item.width && item.height ? `${item.width}×${item.height}` : '—';
  $('#media-duration').textContent = item && item.duration ? fmtTime(item.duration) : '—';
}

function renderMediaList(){
  const list = $('#media-list');
  const query = ($('#media-search').value || '').trim().toLowerCase();
  list.innerHTML = '';

  const visibleItems = state.mediaLibrary.filter(item => {
    return !query || item.name.toLowerCase().includes(query) || item.typeLabel.toLowerCase().includes(query);
  });

  if(!visibleItems.length){
    updateMediaUI();
    return;
  }

  visibleItems.forEach(item => {
    const card = document.createElement('button');
    card.type = 'button';
    card.draggable = true;
    card.className = 'media-item' + (item.id === state.activeMediaId ? ' active' : '');
    card.dataset.id = item.id;
    card.innerHTML = `
      <div class="media-thumb">${getMediaIcon(item.kind)}</div>
      <div class="media-item-body">
        <div class="media-item-name">${item.name}</div>
        <div class="media-item-meta">${item.typeLabel} • ${formatBytes(item.size)}${item.duration ? ' • ' + fmtTime(item.duration) : ''}</div>
      </div>
    `;
    card.addEventListener('click', ()=>{
      state.activeMediaId = item.id;
      renderMediaList();
      updateMediaUI();
      loadMediaFromItem(item);
    });
    card.addEventListener('dragstart', e=>{
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/media-id', item.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', ()=>card.classList.remove('dragging'));
    list.appendChild(card);
  });
  updateMediaUI();
}

function registerMedia(file, options = {}){
  if(!file) return;
  const kind = getMediaKind(file);
  const item = {
    id: `media-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    name: file.name,
    kind,
    typeLabel: kind === 'file' ? 'File' : kind.charAt(0).toUpperCase() + kind.slice(1),
    size: file.size,
    url: URL.createObjectURL(file),
    width: 0,
    height: 0,
    duration: 0,
    lastUsed: Date.now()
  };

  const fillMetadata = (meta) => {
    item.width = meta.width || item.width;
    item.height = meta.height || item.height;
    item.duration = meta.duration || item.duration;
    if(item.kind === 'video' || item.kind === 'audio') item.typeLabel = item.kind === 'video' ? 'Video' : 'Audio';
  };

  if(kind === 'video'){ 
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      fillMetadata({ width: probe.videoWidth, height: probe.videoHeight, duration: probe.duration });
      if(options.autoLoad) loadMediaFromItem(item);
      renderMediaList();
    };
    probe.src = item.url;
  } else if(kind === 'image'){ 
    const img = new Image();
    img.onload = () => {
      fillMetadata({ width: img.width, height: img.height });
      if(options.autoLoad) loadMediaFromItem(item);
      renderMediaList();
    };
    img.src = item.url;
  } else if(kind === 'audio'){ 
    const probe = document.createElement('audio');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      fillMetadata({ duration: probe.duration });
      if(options.autoLoad) loadMediaFromItem(item);
      renderMediaList();
    };
    probe.src = item.url;
  } else {
    if(options.autoLoad) loadMediaFromItem(item);
    renderMediaList();
  }

  if(options.replaceId){
    const idx = state.mediaLibrary.findIndex(m => m.id === options.replaceId);
    if(idx >= 0){
      const old = state.mediaLibrary[idx];
      if(old && old.url && old.url.startsWith('blob:')) URL.revokeObjectURL(old.url);
      state.mediaLibrary[idx] = item;
      state.activeMediaId = item.id;
      renderMediaList();
      if(options.autoLoad) loadMediaFromItem(item);
      return;
    }
  }

  state.mediaLibrary.push(item);
  state.activeMediaId = item.id;
  if(options.autoLoad) loadMediaFromItem(item);
  renderMediaList();
  toast('Media added to library');
}

function loadMediaFromItem(item){
  if(!item) return;
  state.activeMediaId = item.id;
  mediaPreview.pause();
  mediaPreview.src = item.kind === 'video' ? item.url : '';
  mediaPreview.load();
  $('#source-preview-empty').classList.toggle('hidden', item.kind === 'video');
  $('#media-preview-time').textContent = item.kind === 'video' ? `00:00.0 / ${fmtTime(item.duration)}` : 'Preview unavailable';
  state.media = {
    fileName: item.name,
    fileType: item.typeLabel,
    fileSize: item.size,
    width: item.width || 0,
    height: item.height || 0,
    duration: item.duration || 0,
    status: `Source preview: ${item.name}`
  };
  renderMediaList();
  updateMediaUI();
}

function deleteMediaItem(id){
  const idx = state.mediaLibrary.findIndex(item => item.id === id);
  if(idx < 0) return;
  const [removed] = state.mediaLibrary.splice(idx, 1);
  if(removed && removed.url && removed.url.startsWith('blob:')) URL.revokeObjectURL(removed.url);
  state.activeMediaId = state.mediaLibrary[0] ? state.mediaLibrary[0].id : null;
  if(!state.mediaLibrary.length){
    state.videoLoaded = false;
    state.timelineClip = null;
    dropZone.classList.remove('hidden');
    $('#timeline-empty').classList.remove('hidden');
    $('#timeline-clip')?.remove();
    $('#btn-export').disabled = true;
    state.media = {fileName:'', fileType:'', fileSize:0, width:0, height:0, duration:0, status:'No media loaded'};
    video.removeAttribute('src');
    video.load();
  }
  renderMediaList();
  updateMediaUI();
}

function chooseMediaFile(replaceCurrent = false){
  if(replaceCurrent){
    state.replaceMediaPending = true;
    fileInput.click();
    return;
  }
  fileInput.click();
}

$('#btn-import-media').addEventListener('click', ()=> chooseMediaFile(false));
$('#btn-replace-media').addEventListener('click', ()=> chooseMediaFile(true));
$('#btn-delete-sequence').addEventListener('click', ()=>{
  if(state.activeMediaId) deleteMediaItem(state.activeMediaId);
});
$('#btn-new-sequence').addEventListener('click', ()=> toast('Sequences are ready for your next edit'));
$('#media-search').addEventListener('input', renderMediaList);
$('#sequence-row').addEventListener('dblclick', ()=> chooseMediaFile(false));
$('#btn-clear-media').addEventListener('click', ()=>{
  state.mediaLibrary.forEach(item => {
    if(item.url && item.url.startsWith('blob:')) URL.revokeObjectURL(item.url);
  });
  state.mediaLibrary = [];
  state.activeMediaId = null;
  state.videoLoaded = false;
  state.timelineClip = null;
  dropZone.classList.remove('hidden');
  $('#timeline-empty').classList.remove('hidden');
  $('#timeline-clip')?.remove();
  state.media = {fileName:'', fileType:'', fileSize:0, width:0, height:0, duration:0, status:'No media loaded'};
  video.removeAttribute('src');
  video.load();
  mediaPreview.removeAttribute('src');
  mediaPreview.load();
  updateMediaUI();
  renderMediaList();
  toast('Media library cleared');
});

fileInput.addEventListener('change', e=>{
  const files = Array.from(e.target.files || []);
  if(!files.length) return;
  if(state.replaceMediaPending && state.activeMediaId){
    const targetId = state.activeMediaId;
    const next = files[0];
    registerMedia(next, { autoLoad: true, replaceId: targetId });
    state.replaceMediaPending = false;
    e.target.value = '';
    return;
  }
  files.forEach(file => registerMedia(file, { autoLoad: true }));
  e.target.value = '';
});

dropZone.addEventListener('click', ()=>fileInput.click());
$('#btn-open').addEventListener('click', ()=>fileInput.click());

['dragenter','dragover'].forEach(ev=>dropZone.addEventListener(ev, e=>{
  e.preventDefault(); dropZone.classList.add('dragover');
}));
['dragleave','drop'].forEach(ev=>dropZone.addEventListener(ev, e=>{
  e.preventDefault(); dropZone.classList.remove('dragover');
}));
dropZone.addEventListener('drop', e=>{
  const files = Array.from(e.dataTransfer.files || []);
  files.forEach(file => registerMedia(file, { autoLoad: true }));
});

$('#btn-media-preview-play').addEventListener('click', ()=>{
  if(!mediaPreview.src) return;
  if(mediaPreview.paused) mediaPreview.play();
  else mediaPreview.pause();
});

function loadTimelineClip(item){
  if(!item || item.kind !== 'video') return;
  state.timelineClip = {mediaId:item.id, name:item.name, duration:item.duration || 0};
  video.pause();
  video.src = item.url;
  video.load();
  video.addEventListener('loadedmetadata', function onMeta(){
    video.removeEventListener('loadedmetadata', onMeta);
    state.videoLoaded = true;
    state.duration = video.duration;
    state.trimIn = 0;
    state.trimOut = video.duration;
    const targetW = 1280;
    const scale = targetW / video.videoWidth;
    canvas.width = targetW;
    canvas.height = Math.round(video.videoHeight * scale);
    dropZone.classList.add('hidden');
    $('#timeline-empty').classList.add('hidden');
    $('#btn-export').disabled = false;
    $('#hud-res').textContent = `${video.videoWidth}×${video.videoHeight}`;
    $('#dur-time').textContent = fmtTime(video.duration);
    renderTimelineClip(item);
    generateThumbnails();
    layoutTrim();
    renderMarkers();
    renderKeyframes();
    toast(`${item.name} added to timeline`);
  }, {once:true});
}

/* ---------------- Transport ---------------- */
const btnPlay = $('#btn-playpause');
function setPlaying(p){
  state.playing = p;
  btnPlay.textContent = p ? '❚❚' : '▶';
  if(p){
    if(video.currentTime >= state.trimOut - 0.02) video.currentTime = state.trimIn;
    video.play();
  } else {
    video.pause();
  }
}
btnPlay.addEventListener('click', ()=>{
  if(!state.videoLoaded) return;
  setPlaying(!state.playing);
});
$('#btn-back').addEventListener('click', ()=>{ if(state.videoLoaded) video.currentTime = Math.max(state.trimIn, video.currentTime-5); });
$('#btn-fwd').addEventListener('click', ()=>{ if(state.videoLoaded) video.currentTime = Math.min(state.trimOut, video.currentTime+5); });

video.addEventListener('timeupdate', ()=>{
  if(state.playing && video.currentTime >= state.trimOut - 0.02){
    video.pause();
    video.currentTime = state.trimIn;
    state.playing = false;
    btnPlay.textContent = '▶';
  }
});

function fmtTime(t){
  if(!isFinite(t)) return '00:00.0';
  const m = Math.floor(t/60);
  const s = (t%60).toFixed(1).padStart(4,'0');
  return String(m).padStart(2,'0')+':'+s;
}
function updateTimeUI(){
  if(!state.videoLoaded) return;
  $('#cur-time').textContent = fmtTime(video.currentTime);
  const track = $('#track');
  const w = track.clientWidth;
  const x = (video.currentTime/state.duration)*w;
  $('#playhead').style.left = x+'px';
}

/* ---------------- Adjustment sliders ---------------- */
function bindSlider(id, key, fmt){
  const el = $('#'+id);
  const label = $('#'+id+'Val');
  el.addEventListener('input', ()=>{
    const raw = parseFloat(el.value);
    let mapped = raw;
    if(key==='gamma') mapped = raw/100;
    if(key==='speed') mapped = raw/100;
    if(key==='volume') mapped = raw/100;
    if(key in state.adjust) state.adjust[key] = mapped;
    if(label) label.textContent = fmt ? fmt(raw) : raw;
    if(key==='speed') video.playbackRate = mapped;
    if(key==='volume') video.volume = Math.min(1, mapped);
  });
}
bindSlider('brightness','brightness', v=>v);
bindSlider('contrast','contrast', v=>v);
bindSlider('saturation','saturation', v=>v);
bindSlider('hue','hue', v=>v+'°');
bindSlider('gamma','gamma', v=>(v/100).toFixed(2));
bindSlider('sharpen','sharpen', v=>v);
bindSlider('vignette','vignette', v=>v);
bindSlider('grain','grain', v=>v);
bindSlider('speed','speed', v=>(v/100).toFixed(2)+'x');
bindSlider('volume','volume', v=>v+'%');

/* ---------------- Video Control tab ---------------- */
bindSlider('scale','__scale', v=>v+'%');
bindSlider('posX','__posX', v=>v);
bindSlider('posY','__posY', v=>v);
bindSlider('rotation','__rotation', v=>v+'°');
bindSlider('cropTop','__cropTop', v=>v+'%');
bindSlider('cropBottom','__cropBottom', v=>v+'%');
bindSlider('cropLeft','__cropLeft', v=>v+'%');
bindSlider('cropRight','__cropRight', v=>v+'%');

// The generic bindSlider writes into state.adjust — patch it for these keys:
function wireVideoCtl(){
  $('#scale').addEventListener('input', e=> state.transform.scale = parseFloat(e.target.value));
  $('#posX').addEventListener('input', e=> state.transform.posX = parseFloat(e.target.value));
  $('#posY').addEventListener('input', e=> state.transform.posY = parseFloat(e.target.value));
  $('#rotation').addEventListener('input', e=> state.transform.rotation = parseFloat(e.target.value));
  ['Top','Bottom','Left','Right'].forEach(side=>{
    $('#crop'+side).addEventListener('input', e=>{
      state.crop[side.toLowerCase()] = parseFloat(e.target.value);
      // clamp: left+right <= 98, top+bottom <= 98
      if(state.crop.left + state.crop.right > 98){
        state.crop.right = 98 - state.crop.left;
        $('#cropRight').value = state.crop.right;
      }
      if(state.crop.top + state.crop.bottom > 98){
        state.crop.bottom = 98 - state.crop.top;
        $('#cropBottom').value = state.crop.bottom;
      }
    });
  });
}
wireVideoCtl();

$('#btn-reset-crop').addEventListener('click', ()=>{
  state.crop = {top:0,bottom:0,left:0,right:0};
  ['Top','Bottom','Left','Right'].forEach(s=>{
    $('#crop'+s).value = 0;
    $('#crop'+s+'Val').textContent = '0%';
  });
  renderOverlays(); // refresh marker/keyframe visuals
  toast('Crop reset');
});

/* ---------------- Markers ---------------- */
let markerIdSeq = 1;
function addMarker(){
  if(!state.videoLoaded){ toast('Load a video first'); return; }
  state.markers.push({id: markerIdSeq++, time: video.currentTime});
  renderMarkers();
  toast('Marker added');
}
$('#btn-add-marker').addEventListener('click', addMarker);

function renderMarkers(){
  const list = $('#marker-list');
  const ruler = $('#ruler');
  list.innerHTML = '';
  // remove old ruler markers
  $$('.ruler-marker', ruler).forEach(el=>el.remove());
  state.markers.sort((a,b)=>a.time-b.time);
  state.markers.forEach(m=>{
    const item = document.createElement('div');
    item.className = 'marker-item';
    item.innerHTML = `<span class="t">${fmtTime(m.time)}</span><span class="del">✕</span>`;
    item.addEventListener('click', e=>{
      if(e.target.classList.contains('del')){
        state.markers = state.markers.filter(x=>x.id!==m.id);
        renderMarkers();
        return;
      }
      video.currentTime = m.time;
    });
    list.appendChild(item);

    const dot = document.createElement('div');
    dot.className = 'ruler-marker';
    dot.style.left = ((m.time/state.duration)*100)+'%';
    dot.title = fmtTime(m.time);
    dot.addEventListener('click', ()=>{ video.currentTime = m.time; });
    ruler.appendChild(dot);
  });
}

/* ---------------- Keyframes ---------------- */
let keyframeIdSeq = 1;
function addKeyframe(){
  if(!state.videoLoaded){ toast('Load a video first'); return; }
  const kf = {
    id: keyframeIdSeq++,
    time: video.currentTime,
    transform: {...state.transform},
    crop: {...state.crop},
    adjust: {...state.adjust}
  };
  state.keyframes.push(kf);
  state.activeKeyframeId = kf.id;
  renderKeyframes();
  toast('Keyframe added');
}
$('#btn-add-keyframe').addEventListener('click', addKeyframe);

function renderKeyframes(){
  const list = $('#keyframe-list');
  list.innerHTML = '';
  // remove old track diamonds
  $$('.track-keyframe', track).forEach(el=>el.remove());
  state.keyframes.sort((a,b)=>a.time-b.time);
  state.keyframes.forEach(kf=>{
    const item = document.createElement('div');
    item.className = 'keyframe-item';
    item.innerHTML = `
      <div class="kf-row">
        <span class="t">${fmtTime(kf.time)}</span>
        <span class="del">✕</span>
      </div>
      <div class="kf-vals">S:${kf.transform.scale}% X:${kf.transform.posX} Y:${kf.transform.posY} R:${kf.transform.rotation}°</div>`;
    item.addEventListener('click', e=>{
      if(e.target.classList.contains('del')){
        state.keyframes = state.keyframes.filter(x=>x.id!==kf.id);
        if(state.activeKeyframeId===kf.id) state.activeKeyframeId=null;
        renderKeyframes();
        return;
      }
      video.currentTime = kf.time;
      // load values into state so user sees them and can tweak
      state.transform = {...kf.transform};
      state.crop = {...kf.crop};
      // update all slider UI
      $('#scale').value = state.transform.scale;
      $('#scaleVal').textContent = state.transform.scale+'%';
      $('#posX').value = state.transform.posX; $('#posXVal').textContent = state.transform.posX;
      $('#posY').value = state.transform.posY; $('#posYVal').textContent = state.transform.posY;
      $('#rotation').value = state.transform.rotation; $('#rotationVal').textContent = state.transform.rotation+'°';
      ['Top','Bottom','Left','Right'].forEach(s=>{
        const key = s.toLowerCase();
        $('#crop'+s).value = state.crop[key];
        $('#crop'+s+'Val').textContent = state.crop[key]+'%';
      });
    });
    list.appendChild(item);

    const diamond = document.createElement('div');
    diamond.className = 'track-keyframe' + (kf.id===state.activeKeyframeId ? ' active' : '');
    diamond.style.left = ((kf.time/state.duration)*100)+'%';
    diamond.title = 'Keyframe @ '+fmtTime(kf.time);
    diamond.addEventListener('click', (e)=>{
      e.stopPropagation();
      video.currentTime = kf.time;
      state.activeKeyframeId = kf.id;
      renderKeyframes();
    });
    track.appendChild(diamond);
  });
}

$('#fxIntensity').addEventListener('input', e=>{
  state.fxIntensity = parseFloat(e.target.value)/100;
  $('#fxIntensityVal').textContent = e.target.value+'%';
});

/* ---------------- Tabs ---------------- */
$$('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    $$('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    $$('.tab-page').forEach(p=>p.style.display = (p.dataset.page===tab.dataset.tab) ? 'block' : 'none');
  });
});

/* ---------------- Timeline / trim ---------------- */
const track = $('#track');
const handleL = $('#handle-l');
const handleR = $('#handle-r');
const shadeL = $('#trim-shade-l');
const shadeR = $('#trim-shade-r');

function renderTimelineClip(item){
  $('#timeline-clip')?.remove();
  const clip = document.createElement('div');
  clip.id = 'timeline-clip';
  clip.className = 'timeline-clip';
  clip.innerHTML = `<span class="timeline-clip-label">${item.name}</span>`;
  track.appendChild(clip);
  $('#timeline-empty').classList.add('hidden');
}

track.addEventListener('dragover', e=>{
  if(Array.from(e.dataTransfer.types || []).includes('text/media-id')){
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    track.classList.add('timeline-drop-target');
  }
});
track.addEventListener('dragleave', ()=>track.classList.remove('timeline-drop-target'));
track.addEventListener('drop', e=>{
  e.preventDefault();
  track.classList.remove('timeline-drop-target');
  const id = e.dataTransfer.getData('text/media-id');
  const item = state.mediaLibrary.find(media => media.id === id);
  if(!item) return;
  if(item.kind !== 'video'){
    toast('Only video clips can be added to the timeline');
    return;
  }
  loadTimelineClip(item);
});

$$('.trim-mode').forEach(button=>button.addEventListener('click', ()=>{
  if(!state.videoLoaded){ toast('Drag a video to the timeline first'); return; }
  state.trimMode = button.dataset.trimMode;
  $$('.trim-mode').forEach(control=>control.classList.toggle('active', control === button));
  if(state.trimMode === 'left'){
    state.trimIn = 0;
    video.currentTime = 0;
    $('#trim-mode-hint').textContent = 'Deletes everything before the selected out point';
  } else if(state.trimMode === 'right'){
    state.trimOut = state.duration;
    video.currentTime = state.trimOut;
    $('#trim-mode-hint').textContent = 'Deletes everything after the selected in point';
  } else {
    $('#trim-mode-hint').textContent = 'Keeps the selected range';
  }
  layoutTrim();
}));

function layoutTrim(){
  if(!state.videoLoaded) return;
  const w = track.clientWidth;
  const xL = (state.trimIn/state.duration)*w;
  const xR = (state.trimOut/state.duration)*w;
  handleL.style.left = xL+'px';
  handleR.style.left = (xR-10)+'px';
  shadeL.style.width = xL+'px';
  shadeR.style.width = (w-xR)+'px';
  $('#trim-in-lbl').textContent = state.trimIn.toFixed(1)+'s';
  $('#trim-out-lbl').textContent = state.trimOut.toFixed(1)+'s';
}
function syncTrimClamp(){
  if(state.playing && (video.currentTime < state.trimIn - 0.05)){
    video.currentTime = state.trimIn;
  }
}

function dragHandle(handle, isLeft){
  handle.addEventListener('pointerdown', e=>{
    e.preventDefault();
    const move = (ev)=>{
      const rect = track.getBoundingClientRect();
      let x = Math.min(Math.max(ev.clientX-rect.left,0), rect.width);
      let t = (x/rect.width)*state.duration;
      if(isLeft){
        state.trimIn = Math.min(t, state.trimOut-0.2);
        video.currentTime = state.trimIn;
      } else {
        state.trimOut = Math.max(t, state.trimIn+0.2);
        video.currentTime = state.trimOut;
      }
      layoutTrim();
    };
    const up = ()=>{
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
dragHandle(handleL, true);
dragHandle(handleR, false);

track.addEventListener('click', e=>{
  if(!state.videoLoaded) return;
  if(e.target===handleL || e.target===handleR) return;
  const rect = track.getBoundingClientRect();
  const x = e.clientX-rect.left;
  const t = (x/rect.width)*state.duration;
  video.currentTime = Math.min(Math.max(t, state.trimIn), state.trimOut);
});

async function generateThumbnails(){
  const thumbsEl = $('#thumbs');
  thumbsEl.innerHTML = '';
  const count = 10;
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = 120; tmpCanvas.height = 68;
  const tctx = tmpCanvas.getContext('2d');
  const wasTime = video.currentTime;
  const wasPlaying = state.playing;
  video.pause();

  for(let i=0;i<count;i++){
    const t = (state.duration/count)*i + 0.05;
    await seekTo(t);
    tctx.drawImage(video, 0,0, tmpCanvas.width, tmpCanvas.height);
    const img = document.createElement('img');
    img.src = tmpCanvas.toDataURL('image/jpeg', 0.6);
    thumbsEl.appendChild(img);
  }
  video.currentTime = wasTime;
  if(wasPlaying) video.play();
}
function seekTo(t){
  return new Promise(resolve=>{
    const onSeek = ()=>{ video.removeEventListener('seeked', onSeek); resolve(); };
    video.addEventListener('seeked', onSeek);
    video.currentTime = t;
  });
}

/* ---------------- Text overlays ---------------- */
const overlayLayer = $('#overlay-layer');
let textIdSeq = 1;

function addText(){
  const t = {
    id: textIdSeq++,
    content: 'Your text here',
    x: 50, y: 50, color:'#ffffff', size:42,
    font:"Inter, sans-serif", style:'shadow'
  };
  state.texts.push(t);
  state.selectedTextId = t.id;
  renderTextList();
  renderOverlays();
  openTextEditor(t);
}
$('#btn-add-text').addEventListener('click', addText);

function renderTextList(){
  const list = $('#text-list');
  list.innerHTML = '';
  state.texts.forEach(t=>{
    const item = document.createElement('div');
    item.className = 'text-item' + (t.id===state.selectedTextId ? ' active':'');
    item.innerHTML = `<span>${t.content.slice(0,18) || '(empty)'}</span><span class="del">✕</span>`;
    item.addEventListener('click', (e)=>{
      if(e.target.classList.contains('del')){
        state.texts = state.texts.filter(x=>x.id!==t.id);
        if(state.selectedTextId===t.id) state.selectedTextId=null;
        renderTextList(); renderOverlays();
        $('#text-editor').style.display = state.texts.length ? $('#text-editor').style.display : 'none';
        return;
      }
      state.selectedTextId = t.id;
      renderTextList(); renderOverlays();
      openTextEditor(t);
    });
    list.appendChild(item);
  });
}

function styleCss(t){
  switch(t.style){
    case 'outline': return `-webkit-text-stroke:1.5px #000; text-shadow:none;`;
    case 'glow': return `text-shadow:0 0 12px ${t.color}, 0 0 24px ${t.color};`;
    case 'bg': return `background:rgba(0,0,0,0.55); border-radius:4px; text-shadow:none;`;
    case 'normal': return `text-shadow:none;`;
    default: return `text-shadow:0 2px 6px rgba(0,0,0,.6);`;
  }
}

function renderOverlays(){
  overlayLayer.innerHTML = '';
  state.texts.forEach(t=>{
    const el = document.createElement('div');
    el.className = 'text-overlay' + (t.id===state.selectedTextId ? ' selected':'');
    el.style.left = t.x+'%';
    el.style.top = t.y+'%';
    el.style.transform = 'translate(-50%,-50%)';
    el.style.color = t.color;
    el.style.fontSize = t.size+'px';
    el.style.fontFamily = t.font;
    el.style.fontWeight = '700';
    el.setAttribute('style', el.getAttribute('style') + ';' + styleCss(t));
    el.textContent = t.content;
    el.addEventListener('pointerdown', e=>{
      e.stopPropagation();
      state.selectedTextId = t.id;
      renderTextList(); renderOverlays(); openTextEditor(t);
      const stageRect = $('#stage-inner').getBoundingClientRect();
      const move = (ev)=>{
        const x = ((ev.clientX-stageRect.left)/stageRect.width)*100;
        const y = ((ev.clientY-stageRect.top)/stageRect.height)*100;
        t.x = Math.min(Math.max(x,0),100);
        t.y = Math.min(Math.max(y,0),100);
        renderOverlays();
      };
      const up = ()=>{
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    overlayLayer.appendChild(el);
  });
}

function openTextEditor(t){
  $('#text-editor').style.display = 'block';
  $('#te-content').value = t.content;
  $('#te-color').value = t.color;
  $('#te-size').value = t.size;
  $('#te-font').value = t.font;
  $('#te-style').value = t.style;
}
['te-content','te-color','te-size','te-font','te-style'].forEach(id=>{
  $('#'+id).addEventListener('input', ()=>{
    const t = state.texts.find(x=>x.id===state.selectedTextId);
    if(!t) return;
    t.content = $('#te-content').value;
    t.color = $('#te-color').value;
    t.size = parseInt($('#te-size').value)||42;
    t.font = $('#te-font').value;
    t.style = $('#te-style').value;
    renderTextList();
    renderOverlays();
  });
});

/* ---------------- Keyboard ---------------- */
window.addEventListener('keydown', e=>{
  if(e.target.tagName==='INPUT' || e.target.tagName==='SELECT') return;
  if(e.code==='Space'){
    e.preventDefault();
    if(state.activeMediaId && mediaPreview.src){
      if(mediaPreview.paused) mediaPreview.play();
      else mediaPreview.pause();
      return;
    }
    if(state.videoLoaded) setPlaying(!state.playing);
  }
});

/* ---------------- Export ---------------- */
const exportModal = $('#export-modal');
$('#btn-export').addEventListener('click', async ()=>{
  if(!state.videoLoaded) return;
  await exportVideo();
});

async function exportVideo(){
  exportModal.classList.add('show');
  $('#progress-fill').style.width='0%';
  $('#progress-pct').textContent='0%';

  const wasPlaying = state.playing;
  setPlaying(false);
  video.playbackRate = state.adjust.speed;

  const glStream = canvas.captureStream(30);

  // Composite text overlays via a 2D overlay canvas merged with an OffscreenCanvas-esque approach:
  // We draw overlay layer text onto a 2nd canvas each frame and combine using a compositing canvas.
  const outCanvas = document.createElement('canvas');
  outCanvas.width = canvas.width;
  outCanvas.height = canvas.height;
  const octx = outCanvas.getContext('2d');
  const outStream = outCanvas.captureStream(30);

  // audio track from video element
  let audioTrack = null;
  try{
    const audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const src = audioCtx.createMediaElementSource(video);
    const dest = audioCtx.createMediaStreamDestination();
    const gainNode = audioCtx.createGain();
    gainNode.gain.value = state.adjust.volume;
    src.connect(gainNode).connect(dest);
    src.connect(audioCtx.destination);
    audioTrack = dest.stream.getAudioTracks()[0];
  }catch(err){ console.warn('Audio capture failed', err); }

  const combined = new MediaStream();
  outStream.getVideoTracks().forEach(t=>combined.addTrack(t));
  if(audioTrack) combined.addTrack(audioTrack);

  let mime = 'video/webm;codecs=vp9,opus';
  if(!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm;codecs=vp8,opus';
  if(!MediaRecorder.isTypeSupported(mime)) mime = 'video/webm';

  const recorder = new MediaRecorder(combined, {mimeType:mime, videoBitsPerSecond:8_000_000});
  const chunks = [];
  recorder.ondataavailable = e=>{ if(e.data.size>0) chunks.push(e.data); };

  const done = new Promise(resolve=>{ recorder.onstop = resolve; });

  video.currentTime = state.trimIn;
  await seekTo(state.trimIn);
  video.play();

  const clipDuration = (state.trimOut - state.trimIn) / state.adjust.speed;
  const start = performance.now();

  recorder.start();

  function drawFrame(){
    octx.drawImage(canvas, 0,0, outCanvas.width, outCanvas.height);
    state.texts.forEach(t=>{
      octx.save();
      octx.font = `700 ${t.size * (outCanvas.width/canvas.clientWidth||1)}px ${t.font}`;
      octx.fillStyle = t.color;
      octx.textAlign = 'center';
      octx.textBaseline = 'middle';
      const px = (t.x/100)*outCanvas.width;
      const py = (t.y/100)*outCanvas.height;
      if(t.style==='bg'){
        const metrics = octx.measureText(t.content);
        octx.fillStyle = 'rgba(0,0,0,0.55)';
        octx.fillRect(px-metrics.width/2-10, py-t.size/2-6, metrics.width+20, t.size+12);
        octx.fillStyle = t.color;
      }
      if(t.style==='outline'){
        octx.strokeStyle='#000'; octx.lineWidth=3;
        octx.strokeText(t.content, px, py);
      }
      if(t.style==='glow'){
        octx.shadowColor = t.color; octx.shadowBlur = 20;
      } else if(t.style!=='outline'){
        octx.shadowColor='rgba(0,0,0,.6)'; octx.shadowBlur=6;
      }
      octx.fillText(t.content, px, py);
      octx.restore();
    });

    const elapsed = (performance.now()-start)/1000;
    const pct = Math.min(100, Math.round((elapsed/clipDuration)*100));
    $('#progress-fill').style.width = pct+'%';
    $('#progress-pct').textContent = pct+'%';

    if(video.currentTime < state.trimOut - 0.03 && elapsed < clipDuration + 0.5){
      requestAnimationFrame(drawFrame);
    } else {
      recorder.stop();
      video.pause();
    }
  }
  requestAnimationFrame(drawFrame);

  await done;

  const blob = new Blob(chunks, {type:'video/webm'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'x-cut-export.webm';
  document.body.appendChild(a);
  a.click();
  a.remove();

  exportModal.classList.remove('show');
  toast('Export complete — download started ✓');
  video.playbackRate = state.adjust.speed;
  if(wasPlaying) setPlaying(true);
}

/* ---------------- Resize handling ---------------- */
window.addEventListener('resize', ()=>{ window.addEventListener('resize', ()=>{ layoutTrim(); renderMarkers(); renderKeyframes(); }); });

})();