// Motion Tracker (YOLO ONNX) 안정화 버전

const $ = (id) => document.getElementById(id);
const video = document.querySelector('.video-wrap > video'); // 첫 번째 video
const overlay = $('overlay');
const framePreview = $('framePreview');

let modelSession = null;
let modelLoaded = false;
let detectionsPerFrame = [];
let frameROIs = [];     // 프레임별 ROI 저장 (캔버스 좌표계)
let roi = null;         // 현재 오버레이 표시용 ROI (오버레이 좌표계)
let posChart = null;
let velChart = null;
let scalePxPerUnit = 100;
let lastNavTime = 0;

// 입력/버튼
const videoFile = $('videoFile');
const startCameraBtn = $('startCamera');
const recordToggleBtn = $('recordToggle');
const extractFramesBtn = $('extractFramesBtn');
const prevFrameBtn = $('prevFrame');
const nextFrameBtn = $('nextFrame');
const frameIdxEl = $('frameIdx');
const extractProgress = $('extractProgress');
const progressBar = $('progressBar');
const progressText = $('progressText');

const stepCamera = $('stepCamera');
const stepExtract = $('stepExtract');
const stepROI = $('stepROI');
const stepAnalyzeBtn = $('stepAnalyze');
const runDetectBtn = $('runDetectBtn');
const completeROIsBtn = $('completeROIs');
const playResultsBtn = $('playResultsBtn');
const exportCSVBtn = $('exportCSV');

const fpsInput = $('fpsInput');
const confInput = $('confInput');
const scaleInput = $('scaleInput');

// 탭 전환
function switchTab(n){
  [1,2,3,4].forEach(i=>{
    const panel = document.getElementById('tab-'+i);
    const btn = document.getElementById('step'+(i===1?'Camera':(i===2?'Extract':(i===3?'ROI':'Analyze'))));
    if(panel) panel.style.display = (i===n) ? '' : 'none';
    if(btn){ if(i===n) btn.classList.add('active'); else btn.classList.remove('active'); }
  });
}
stepCamera?.addEventListener('click', ()=>switchTab(1));
stepExtract?.addEventListener('click', ()=>switchTab(2));
stepROI?.addEventListener('click', ()=>switchTab(3));
stepAnalyzeBtn?.addEventListener('click', ()=>switchTab(4));

// 기본값 접근
const numOr = (v, def) => { const n = Number(v); return Number.isFinite(n) ? n : def; };
function getFpsValue(){ return Math.max(1, numOr(fpsInput?.value, 10)); }
function getConfValue(){ const v = numOr(confInput?.value, 0.3); return Math.max(0, Math.min(1, v)); }
function getScaleValue(){ const v = numOr(scaleInput?.value, 100); scalePxPerUnit = Math.max(0.0001, v); return scalePxPerUnit; }

// 오버레이 DPI 조정
function resizeOverlay(){
  if(!overlay || !video) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(video.clientWidth * dpr));
  const h = Math.max(1, Math.round(video.clientHeight * dpr));
  overlay.width = w; overlay.height = h;
  overlay.style.width = video.clientWidth + 'px';
  overlay.style.height = video.clientHeight + 'px';
}
window.addEventListener('resize', resizeOverlay);
video?.addEventListener('loadedmetadata', resizeOverlay);

// 파일 업로드 → 비디오만 표시(프리뷰/오버레이 숨김)
if(videoFile){
  videoFile.addEventListener('change', async (e)=>{
    const f = e.target.files?.[0];
    if(!f) return;
    const url = URL.createObjectURL(f);

    // 초기 레이어 상태: 비디오만 보이게
    framePreview.style.display = 'none';
    framePreview.style.visibility = 'hidden';
    overlay.style.display = 'none';
    overlay.style.visibility = 'hidden';

    video.srcObject = null;
    video.src = url;
    video.style.display = 'block';
    video.style.visibility = 'visible';
    video.controls = true;
    video.muted = false;
    video.playsInline = true;

    await new Promise(res=>{
      const t = setTimeout(res, 3000);
      function onMeta(){ clearTimeout(t); video.removeEventListener('loadedmetadata', onMeta); res(); }
      video.addEventListener('loadedmetadata', onMeta, {once:true});
    });
    video.play().catch(()=>{});

    extractFramesBtn && (extractFramesBtn.disabled = false);
    switchTab(2);
  });
}

// 카메라/녹화 (옵션)
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
if(startCameraBtn){
  startCameraBtn.addEventListener('click', async ()=>{
    try{
      const s = await navigator.mediaDevices.getUserMedia({ video:{facingMode:'environment'}, audio:false });
      currentStream = s;
      video.srcObject = s; video.muted = true;
      video.playsInline = true; video.controls = false;
      await video.play().catch(()=>{});
      recordToggleBtn && (recordToggleBtn.style.display = '', recordToggleBtn.disabled = false);
    }catch(err){ alert('카메라 접근 실패: '+err.message); }
  });
}
if(recordToggleBtn){
  recordToggleBtn.addEventListener('click', ()=>{
    if(!currentStream) return;
    if(!mediaRecorder || mediaRecorder.state === 'inactive'){
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(currentStream);
      mediaRecorder.ondataavailable = (e)=>{ if(e.data && e.data.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = ()=>{
        const blob = new Blob(recordedChunks, {type:'video/webm'});
        const url = URL.createObjectURL(blob);
        video.srcObject = null; video.src = url; video.muted = false;
        video.play().catch(()=>{});
        extractFramesBtn && (extractFramesBtn.disabled = false);
      };
      mediaRecorder.start(); recordToggleBtn.textContent = '녹화 중지';
    } else {
      mediaRecorder.stop(); recordToggleBtn.textContent = '녹화 시작';
    }
  });
}

// 프레임 추출
let isExtracting = false;
function setProgress(p){ if(progressBar) progressBar.style.width = `${p}%`; if(progressText) progressText.textContent = `${p}%`; }

async function extractFrames(){
  if(isExtracting) return;
  if(!video || (!video.currentSrc && !video.src)) return;
  const srcUrl = video.currentSrc || video.src;

  isExtracting = true; extractedFrames = []; currentFrameIndex = 0;
  extractProgress && (extractProgress.style.display = '');
  setProgress(0);

  try{
    const cap = document.createElement('video');
    cap.muted = true; cap.preload = 'auto'; cap.crossOrigin = 'anonymous';
    cap.src = srcUrl;

    await new Promise(res=>{
      const to = setTimeout(()=>{res();}, 4000);
      cap.addEventListener('loadedmetadata', ()=>{ clearTimeout(to); res(); }, {once:true});
    });

    const fps = getFpsValue();
    const duration = cap.duration || video.duration || 0;
    const total = Math.max(1, Math.floor(duration * fps));

    const dpr = window.devicePixelRatio || 1;
    const cssW = cap.videoWidth || 640;
    const cssH = cap.videoHeight || 360;

    for(let i=0;i<total;i++){
      const t = Math.min(duration, (i / fps));
      await new Promise(res=>{
        let done=false;
        function onSeek(){ if(done) return; done=true; cap.removeEventListener('seeked', onSeek); res(); }
        cap.currentTime = t;
        cap.addEventListener('seeked', onSeek);
        setTimeout(()=>{ if(!done){ done=true; cap.removeEventListener('seeked', onSeek); res(); } }, 1200);
      });

      const c = document.createElement('canvas');
      c._cssWidth = cssW; c._cssHeight = cssH; c._dpr = dpr;
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      const ctx = c.getContext('2d');
      try{ ctx.setTransform(dpr,0,0,dpr,0,0); ctx.drawImage(cap, 0, 0, cssW, cssH); }
      catch{ ctx.fillStyle = '#333'; ctx.fillRect(0,0,cssW,cssH); }
      extractedFrames.push(c);

      const percent = Math.round(((i+1)/total)*100);
      setProgress(percent);
    }

    extractProgress && (extractProgress.style.display = 'none');
    setProgress(100);

    // 프레임 확인 단계: 프리뷰/오버레이를 다시 켜기
    framePreview.style.display = '';
    framePreview.style.visibility = 'visible';
    overlay.style.display = '';
    overlay.style.visibility = 'visible';

    await showFrame(0);
    document.querySelectorAll('.frame-nav').forEach(el=> el.style.display='flex');
  }catch(err){
    console.warn('프레임 추출 오류', err);
  }finally{
    isExtracting = false;
    extractFramesBtn && (extractFramesBtn.disabled = false);
  }
}
extractFramesBtn?.addEventListener('click', ()=>{ extractFramesBtn.disabled = true; extractFrames(); });

// 프레임 표시
let extractedFrames = [], currentFrameIndex = 0;
async function showFrame(idx){
  if(!extractedFrames || !extractedFrames.length) return;
  currentFrameIndex = Math.max(0, Math.min(idx, extractedFrames.length-1));
  const c = extractedFrames[currentFrameIndex];

  await new Promise(r => requestAnimationFrame(r));

  const displayW = framePreview?.clientWidth || video.clientWidth || overlay.clientWidth || 640;
  const displayH = framePreview?.clientHeight || video.clientHeight || overlay.clientHeight || 360;
  const dpr = window.devicePixelRatio || 1;

  overlay.width = Math.max(1, Math.round(displayW * dpr));
  overlay.height = Math.max(1, Math.round(displayH * dpr));
  overlay.style.width = displayW + 'px';
  overlay.style.height = displayH + 'px';

  const ctx = overlay.getContext('2d');
  try{ ctx.setTransform(1,0,0,1,0,0); }catch{}
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  try{ ctx.drawImage(c, 0,0, c.width, c.height, 0,0, displayW, displayH); }catch(e){}

  try{
    framePreview.src = c.toDataURL('image/png');
    framePreview.style.width = displayW + 'px';
    framePreview.style.height = displayH + 'px';
    framePreview.style.objectFit = 'contain';
    framePreview.style.display = '';
    framePreview.style.visibility = 'visible';
    overlay.style.display = '';
    overlay.style.visibility = 'visible';
  }catch(e){}

  frameIdxEl && (frameIdxEl.textContent = `Frame ${currentFrameIndex+1} / ${extractedFrames.length}`);

  const roiObj = frameROIs[currentFrameIndex];
  if(roiObj){
    const srcCssW = c._cssWidth || Math.round((c.width || displayW)/dpr);
    const srcCssH = c._cssHeight || Math.round((c.height || displayH)/dpr);
    const scaleX = displayW / (srcCssW || displayW);
    const scaleY = displayH / (srcCssH || displayH);
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
    ctx.strokeRect(roiObj.x*scaleX, roiObj.y*scaleY, roiObj.w*scaleX, roiObj.h*scaleY);
    ctx.setLineDash([]);
  }
}

// ROI 드래그 입력
let isDrawingROI=false, startX=0, startY=0;
function overlayToCanvasRect(ov){
  const c = extractedFrames[currentFrameIndex];
  const dpr = window.devicePixelRatio || 1;
  const srcCssW = c?(c._cssWidth || Math.round((c.width || overlay.clientWidth)/dpr)) : overlay.clientWidth;
  const srcCssH = c?(c._cssHeight || Math.round((c.height || overlay.clientHeight)/dpr)) : overlay.clientHeight;
  const sx = srcCssW / overlay.clientWidth;
  const sy = srcCssH / overlay.clientHeight;
  return { x: ov.x*sx, y: ov.y*sy, w: ov.w*sx, h: ov.h*sy };
}
overlay.addEventListener('pointerdown', (e)=>{
  const r = overlay.getBoundingClientRect();
  startX = e.clientX - r.left;
  startY = e.clientY - r.top;
  roi = { x:startX, y:startY, w:0, h:0 };
  isDrawingROI = true;
});
overlay.addEventListener('pointermove', (e)=>{
  if(!isDrawingROI || !roi) return;
  const r = overlay.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  roi.w = x - roi.x; roi.h = y - roi.y;
  if(roi.w<0){ roi.x=x; roi.w=Math.abs(roi.w); }
  if(roi.h<0){ roi.y=y; roi.h=Math.abs(roi.h); }
});
overlay.addEventListener('pointerup', ()=>{
  if(!isDrawingROI || !roi) return;
  isDrawingROI = false;
  const canvasROI = overlayToCanvasRect(roi);
  frameROIs[currentFrameIndex] = canvasROI;
});

// 모델 로드(YOLOv8 ONNX)
async function loadModel(){
  const candidatePaths = ['./yolov8n.onnx', './model/yolov8n.onnx'];
  const statusEl = $('status');
  if(statusEl) statusEl.textContent = '모델 로드 상태: 로딩 시도 중...';

  let success = false;
  for(const p of candidatePaths){
    try{
      const resp = await fetch(p, {method:'GET'});
      if(!resp.ok) continue;
      const ab = await resp.arrayBuffer();
      modelSession = await ort.InferenceSession.create(ab, {executionProviders:['wasm','webgl']});
      modelLoaded = true;
      success = true;
      statusEl && (statusEl.textContent = `모델 로드 상태: 성공 (${p})`);
      break;
    }catch(err){ /* 실패시 다음 경로 시도 */ }
  }
  if(!success){
    modelLoaded = false;
    statusEl && (statusEl.innerHTML = '모델 로드 상태: 실패 — <code>yolov8n.onnx</code>를 루트 또는 <code>./model/</code>에 업로드하세요.');
  }
}
loadModel();

// 결과 재생(간단)
let playTimer = null;
function playResults(){
  if(!extractedFrames?.length) return;
  let idx = 0; const total = extractedFrames.length; const fps = getFpsValue();
  if(playTimer) clearInterval(playTimer);
  playTimer = setInterval(()=>{
    const c = extractedFrames[idx];
    const displayW = overlay.clientWidth || video.clientWidth || 640;
    const displayH = overlay.clientHeight || video.clientHeight || 360;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.round(displayW * dpr));
    overlay.height = Math.max(1, Math.round(displayH * dpr));
    overlay.style.width = displayW + 'px';
    overlay.style.height = displayH + 'px';
    const ctx = overlay.getContext('2d');
    try{ ctx.setTransform(1,0,0,1,0,0); }catch{}
    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.setTransform(dpr,0,0,dpr,0,0);
    try{ ctx.drawImage(c,0,0,c.width,c.height,0,0,displayW,displayH); }catch(e){}

    const det = detectionsPerFrame[idx];
    if(det?.box){
      const srcCssW = c._cssWidth || Math.round((c.width || displayW)/dpr);
      const srcCssH = c._cssHeight || Math.round((c.height || displayH)/dpr);
      const scaleX = displayW / (srcCssW || displayW);
      const scaleY = displayH / (srcCssH || displayH);
      const [x1,y1,x2,y2] = det.box;
      ctx.strokeStyle='#ff0066'; ctx.lineWidth=3;
      ctx.strokeRect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY);
    }
    idx++; if(idx>=total) idx=0;
  }, 1000 / fps);
}
playResultsBtn?.addEventListener('click', ()=> playResults());

// CSV 내보내기(간단)
exportCSVBtn?.addEventListener('click', (e)=>{
  e?.preventDefault?.();
  const rows = [['frame','time_s','x_px','y_px','x_unit','y_unit','speed_unit_s','acc_unit_s2']];
  for(let i=0;i<detectionsPerFrame.length;i++){
    const d = detectionsPerFrame[i];
    const t = (d?.time || 0).toFixed(4);
    rows.push([i, t, '', '', '', '', '', '']);
  }
  const csv = rows.map(r=>r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const aTag = document.createElement('a'); aTag.href = url; aTag.download = 'analysis.csv'; aTag.click();
  URL.revokeObjectURL(url);
