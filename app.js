// Motion Tracker 안정화 버전 (핵심 수정)
/* 전반: 기본값 병합 오류 수정, ROI 드래그 입력 추가, 프레임 프리뷰/오버레이 연결 안정화 */

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

// 공용 기본값 헬퍼
const numOr = (v, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
};

// 상태 로그 (모바일 화면 하단 박스)
function userLog(msg) {
  console.log('[Traker]', msg);
  try {
    let el = document.getElementById('mobileStatusLog');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mobileStatusLog';
      Object.assign(el.style, {position:'fixed',left:'8px',right:'8px',bottom:'12px',padding:'8px 10px',background:'rgba(0,0,0,0.7)',color:'#fff',fontSize:'12px',zIndex:9999,maxHeight:'140px',overflow:'auto'});
      document.body.appendChild(el);
    }
    const p = document.createElement('div');
    p.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    el.appendChild(p);
    while (el.childNodes.length > 6) el.removeChild(el.firstChild);
  } catch {}
}

// 비디오 초기화
if (video) {
  try {
    video.playsInline = true;
    video.muted = true;
    video.controls = true;
    video.style.display = 'block';
  } catch {}
}
if (video) {
  video.addEventListener('error', (ev) => {
    console.error('[Traker] video element error', ev);
    userLog('비디오 엘리먼트 오류 발생 (콘솔 확인)');
  });
  video.addEventListener('loadeddata', () => {
    console.log('[Traker] video loadeddata, readyState=', video.readyState);
    resizeOverlay();
  });
}

// 입력/버튼 참조
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

const inspectModelBtn = $('inspectModelBtn'); // 없으면 무시
const modelFileInput = $('modelFileInput');   // 없으면 무시
const stepAnalyzeBtn = $('stepAnalyze');      // 탭 버튼 ID (탭 스위치용)
const runDetectBtn = $('runDetectBtn');
const completeROIsBtn = $('completeROIs');
const playResultsBtn = $('playResultsBtn');
const exportCSVBtn = $('exportCSV');

const stepCamera = $('stepCamera');
const stepExtract = $('stepExtract');
const stepROI = $('stepROI');
const fpsInput = $('fpsInput');
const confInput = $('confInput');
const scaleInput = $('scaleInput');

// 탭 전환
function switchTab(n) {
  try {
    const ids = [1,2,3,4];
    ids.forEach((i) => {
      const panel = document.getElementById(`tab-${i}`);
      const btn = document.getElementById(
        'step' + (i===1? 'Camera' : (i===2? 'Extract' : (i===3? 'ROI' : 'Analyze')))
      );
      if (panel) panel.style.display = (i===n) ? '' : 'none';
      if (btn) {
        if (i===n) btn.classList.add('active'); else btn.classList.remove('active');
      }
    });
  } catch (e) { console.warn('switchTab failed', e); }
}
stepCamera?.addEventListener('click', () => switchTab(1));
stepExtract?.addEventListener('click', () => switchTab(2));
stepROI?.addEventListener('click', () => switchTab(3));
stepAnalyzeBtn?.addEventListener('click', () => switchTab(4));

// 기본값 접근
function getFpsValue() {
  return Math.max(1, numOr(fpsInput?.value, 10));
}
function getConfValue() {
  const v = numOr(confInput?.value, 0.3);
  return Math.max(0, Math.min(1, v));
}
function getScaleValue() {
  const v = numOr(scaleInput?.value, 100);
  scalePxPerUnit = Math.max(0.0001, v);
  return scalePxPerUnit;
}

// 오버레이 DPI 조정
function resizeOverlay() {
  if (!overlay || !video) return;
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(video.clientWidth * dpr));
  const h = Math.max(1, Math.round(video.clientHeight * dpr));
  overlay.width = w; overlay.height = h;
  overlay.style.width = video.clientWidth + 'px';
  overlay.style.height = video.clientHeight + 'px';
}
window.addEventListener('resize', resizeOverlay);
video?.addEventListener('loadedmetadata', () => { resizeOverlay(); });

// 파일 업로드
if (videoFile) {
  videoFile.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) { userLog('파일 선택 취소'); return; }
    userLog(`파일 선택: ${f.name}`);
    try {
      // 카메라 중지
      if (currentStream) {
        try { currentStream.getTracks().forEach(t=>t.stop()); } catch {}
        currentStream = null;
        video.srcObject = null;
      }
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();

      const url = URL.createObjectURL(f);
      video.srcObject = null;
      video.src = url;
      video.style.display = 'block';
      video.playsInline = true;
      video.muted = false;
      video.controls = true;
      console.log('[Traker] set video.src ->', url);

      await new Promise((res) => {
        const t = setTimeout(() => { console.warn('[Traker] loadedmetadata timeout'); res(); }, 3000);
        function onMeta() { clearTimeout(t); video.removeEventListener('loadedmetadata', onMeta); res(); }
        video.addEventListener('loadedmetadata', onMeta, {once:true});
      });

      try {
        userLog(`비디오 로드 완료: ${Math.round(video.duration || 0)}초, ${video.videoWidth}x${video.videoHeight}`);
        await video.play();
      } catch (e2) { userLog('자동 재생 실패(사용자 상호작용 필요)'); console.warn('video.play error', e2); }

      extractFramesBtn && (extractFramesBtn.disabled = false);
      switchTab(2);
    } catch (err) {
      userLog('파일 처리 중 오류: ' + (err && err.message));
    }
  });
} else {
  userLog('videoFile 입력이 없음');
}

// 카메라
let currentStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let extractedFrames = []; // canvas 배열
let currentFrameIndex = 0;

if (startCameraBtn) {
  startCameraBtn.addEventListener('click', async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false });
      currentStream = s;
      video.srcObject = s; video.muted = true;
      video.playsInline = true; video.controls = false;
      await video.play().catch(()=>{});
      userLog('카메라 스트림 재생 중');
      recordToggleBtn && (recordToggleBtn.style.display = '', recordToggleBtn.disabled = false);
    } catch (err) {
      userLog('카메라 접근 실패: ' + err.message);
      alert('카메라 접근 실패: ' + err.message);
    }
  });
}

// 녹화 토글
if (recordToggleBtn) {
  recordToggleBtn.addEventListener('click', () => {
    if (!currentStream) { userLog('카메라가 활성화되어 있지 않습니다'); return; }
    if (!mediaRecorder || mediaRecorder.state === 'inactive') {
      recordedChunks = [];
      mediaRecorder = new MediaRecorder(currentStream);
      mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const blob = new Blob(recordedChunks, {type:'video/webm'});
        const url = URL.createObjectURL(blob);
        video.srcObject = null; video.src = url; video.muted = false;
        video.play().catch(()=>{});
        userLog('녹화 완료, 재생으로 전환');
        extractFramesBtn && (extractFramesBtn.disabled = false);
      };
      mediaRecorder.start();
      recordToggleBtn.textContent = '녹화 중지';
      userLog('녹화 시작');
    } else {
      mediaRecorder.stop();
      recordToggleBtn.textContent = '녹화 시작';
      userLog('녹화 중지');
    }
  });
}

// 프레임 추출
let isExtracting = false;
function setProgress(p){ if(progressBar) progressBar.style.width = `${p}%`; if(progressText) progressText.textContent = `${p}%`; }

async function extractFrames() {
  if (isExtracting) { userLog('이미 추출 중입니다'); return; }
  if (!video || (!video.currentSrc && !video.src)) { userLog('추출할 비디오가 없습니다'); return; }
  const srcUrl = video.currentSrc || video.src;
  if (!srcUrl) { userLog('비디오 소스 없음'); return; }

  isExtracting = true; extractedFrames = []; currentFrameIndex = 0;
  extractProgress && (extractProgress.style.display = '');
  setProgress(0);
  try {
    const cap = document.createElement('video');
    cap.muted = true; cap.preload = 'auto'; cap.crossOrigin = 'anonymous';
    cap.src = srcUrl;

    await new Promise((res) => {
      const to = setTimeout(() => { res(); }, 4000);
      cap.addEventListener('loadedmetadata', () => { clearTimeout(to); res(); }, {once:true});
    });

    const fps = Math.max(1, numOr(fpsInput?.value, 10));
    const duration = cap.duration || video.duration || 0;
    const total = Math.max(1, Math.floor(duration * fps));
    userLog(`프레임 추출: duration=${duration.toFixed(2)}s, fps=${fps}, total=${total}`);

    const dpr = window.devicePixelRatio || 1;
    const cssW = cap.videoWidth || 640;
    const cssH = cap.videoHeight || 360;

    for (let i=0; i<total; i++) {
      const t = Math.min(duration, (i / fps));
      await new Promise((res) => {
        let done = false;
        function onSeek(){ if (done) return; done = true; cap.removeEventListener('seeked', onSeek); res(); }
        cap.currentTime = t;
        cap.addEventListener('seeked', onSeek);
        setTimeout(() => { if(!done){ done=true; cap.removeEventListener('seeked', onSeek); res(); } }, 1200);
      });

      const c = document.createElement('canvas');
      c._cssWidth = cssW; c._cssHeight = cssH; c._dpr = dpr;
      c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
      const ctx = c.getContext('2d');
      try { ctx.setTransform(dpr,0,0,dpr,0,0); ctx.drawImage(cap, 0, 0, cssW, cssH); }
      catch { ctx.fillStyle = '#333'; ctx.fillRect(0,0,cssW,cssH); }
      extractedFrames.push(c);

      const percent = Math.round(((i+1)/total) * 100);
      setProgress(percent);
      if (i % Math.max(1, Math.floor(total/10)) === 0) userLog(`추출 진행: ${i+1}/${total}`);
    }

    userLog(`프레임 추출 완료: ${extractedFrames.length}개`);
    extractProgress && (extractProgress.style.display = 'none');
    setProgress(100);

    await showFrame(0);
    document.querySelectorAll('.frame-nav').forEach(el => el.style.display='flex');
  } catch (err) {
    userLog('프레임 추출 오류: ' + (err && err.message));
  } finally {
    isExtracting = false;
    extractFramesBtn && (extractFramesBtn.disabled = false);
  }
}
extractFramesBtn?.addEventListener('click', () => { extractFramesBtn.disabled = true; extractFrames(); });

// 프레임 표시
async function showFrame(idx) {
  if (!extractedFrames || !extractedFrames.length) return;
  currentFrameIndex = Math.max(0, Math.min(idx, extractedFrames.length-1));
  const c = extractedFrames[currentFrameIndex];

  await new Promise(r => requestAnimationFrame(r));

  const displayW = framePreview?.clientWidth || video.clientWidth || overlay.clientWidth || 640;
  const displayH = framePreview?.clientHeight || video.clientHeight || overlay.clientHeight || 360;
  const dpr = window.devicePixelRatio || 1;

  // 오버레이 내부 픽셀 크기 갱신
  overlay.width = Math.max(1, Math.round(displayW * dpr));
  overlay.height = Math.max(1, Math.round(displayH * dpr));
  overlay.style.width = displayW + 'px';
  overlay.style.height = displayH + 'px';

  const ctx = overlay.getContext('2d');
  try { ctx.setTransform(1,0,0,1,0,0); } catch {}
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // 프레임 그리기(전체에 맞춤)
  try { ctx.drawImage(c, 0,0, c.width, c.height, 0,0, displayW, displayH); } catch (e) { console.warn('drawImage failed', e); }

  // 프리뷰 이미지도 업데이트 (오버레이와 동일 크기)
  try {
    framePreview.src = c.toDataURL('image/png');
    framePreview.style.width = displayW + 'px';
    framePreview.style.height = displayH + 'px';
    framePreview.style.objectFit = 'contain';
    framePreview.style.display = '';
    framePreview.style.visibility = 'visible';
    overlay.style.visibility = 'visible';
  } catch (e) { console.warn('failed to update framePreview', e); }

  // 프레임 인덱스
  frameIdxEl && (frameIdxEl.textContent = `Frame ${currentFrameIndex+1} / ${extractedFrames.length}`);

  // 저장된 ROI가 있으면 스케일 맞춰 그리기
  const roiObj = frameROIs[currentFrameIndex];
  if (roiObj) {
    const srcCssW = c._cssWidth || Math.round((c.width || displayW) / dpr);
    const srcCssH = c._cssHeight || Math.round((c.height || displayH) / dpr);
    const scaleX = displayW / (srcCssW || displayW);
    const scaleY = displayH / (srcCssH || displayH);
    ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 2; ctx.setLineDash([6,4]);
    ctx.strokeRect(roiObj.x*scaleX, roiObj.y*scaleY, roiObj.w*scaleX, roiObj.h*scaleY);
    ctx.setLineDash([]);
  }
}

// 프레임 네비
function bindMulti(el, handler, cooldownMs){
  if(!el) return;
  let last = 0;
  const wrapper = function(e){
    const now = Date.now();
    if(cooldownMs && now - last < cooldownMs) return;
    last = now;
    try{ handler(e); }catch(err){ console.warn('bindMulti handler error', err); }
  };
  el.addEventListener('click', wrapper);
  el.addEventListener('pointerdown', wrapper);
}
if (prevFrameBtn) {
  bindMulti(prevFrameBtn, (e)=> {
    e?.preventDefault?.(); e?.stopPropagation?.();
    if (!extractedFrames?.length) { userLog('이동할 프레임이 없습니다'); return; }
    const now = Date.now(); if (now - lastNavTime < 250) return;
    lastNavTime = now;
    showFrame(Math.max(0, currentFrameIndex - 1));
  }, 300);
}
if (nextFrameBtn) {
  bindMulti(nextFrameBtn, (e)=> {
    e?.preventDefault?.(); e?.stopPropagation?.();
    if (!extractedFrames?.length) { userLog('이동할 프레임이 없습니다'); return; }
    const now = Date.now(); if (now - lastNavTime < 250) return;
    lastNavTime = now;
    showFrame(Math.min(extractedFrames.length - 1, currentFrameIndex + 1));
  }, 300);
}

// === ROI 드래그 입력 추가 ===
let isDrawingROI = false;
let startX = 0, startY = 0;

function drawOverlay() {
  const dpr = window.devicePixelRatio || 1;
  const ctx = overlay.getContext('2d');
  try { ctx.setTransform(1,0,0,1,0,0); } catch {}
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.setTransform(dpr,0,0,dpr,0,0);

  // 현재 프레임 그리기
  if (extractedFrames?.length) {
    const c = extractedFrames[currentFrameIndex];
    const displayW = overlay.clientWidth, displayH = overlay.clientHeight;
    try { ctx.drawImage(c, 0,0, c.width, c.height, 0,0, displayW, displayH); } catch {}
  }

  // ROI 그리기
  if (roi) {
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.setLineDash([6,4]);
    ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);
    ctx.setLineDash([]);
  }

  // 최근 YOLO 박스 그리기
  const last = detectionsPerFrame.length ? detectionsPerFrame[currentFrameIndex] : null;
  if (last?.box) {
    const [x1,y1,x2,y2] = last.box;
    // 캔버스 CSS 크기에 맞춘 스케일
    const c = extractedFrames[currentFrameIndex];
    const srcCssW = c? (c._cssWidth || overlay.clientWidth) : overlay.clientWidth;
    const srcCssH = c? (c._cssHeight || overlay.clientHeight) : overlay.clientHeight;
    const scaleX = overlay.clientWidth / srcCssW;
    const scaleY = overlay.clientHeight / srcCssH;
    ctx.strokeStyle = '#ff0066';
    ctx.lineWidth = 3;
    ctx.strokeRect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY);
  }
}

// 오버레이 좌표 → 현재 프레임 캔버스 좌표 변환
function overlayToCanvasRect(ovRect) {
  const c = extractedFrames[currentFrameIndex];
  const dpr = window.devicePixelRatio || 1;
  const srcCssW = c? (c._cssWidth || Math.round((c.width || overlay.clientWidth)/dpr)) : overlay.clientWidth;
  const srcCssH = c? (c._cssHeight || Math.round((c.height || overlay.clientHeight)/dpr)) : overlay.clientHeight;
  const scaleX = srcCssW / overlay.clientWidth;
  const scaleY = srcCssH / overlay.clientHeight;
  return {
    x: ovRect.x * scaleX,
    y: ovRect.y * scaleY,
    w: ovRect.w * scaleX,
    h: ovRect.h * scaleY,
  };
}

// 포인터 이벤트로 ROI 생성/저장
overlay.addEventListener('pointerdown', (e) => {
  const r = overlay.getBoundingClientRect();
  startX = e.clientX - r.left;
  startY = e.clientY - r.top;
  roi = { x:startX, y:startY, w:0, h:0 };
  isDrawingROI = true;
  drawOverlay();
});
overlay.addEventListener('pointermove', (e) => {
  if (!isDrawingROI || !roi) return;
  const r = overlay.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  roi.w = x - roi.x;
  roi.h = y - roi.y;
  // 음수 크기 보정
  if (roi.w < 0) { roi.x = x; roi.w = Math.abs(roi.w); }
  if (roi.h < 0) { roi.y = y; roi.h = Math.abs(roi.h); }
  drawOverlay();
});
overlay.addEventListener('pointerup', () => {
  if (!isDrawingROI || !roi) return;
  isDrawingROI = false;
  // 프레임 좌표계로 저장
  const canvasROI = overlayToCanvasRect(roi);
  frameROIs[currentFrameIndex] = canvasROI;
  userLog(`ROI 저장: frame=${currentFrameIndex+1}, x=${canvasROI.x.toFixed(1)}, y=${canvasROI.y.toFixed(1)}, w=${canvasROI.w.toFixed(1)}, h=${canvasROI.h.toFixed(1)}`);
});

// 분석/재생/CSV 등 (기존 로직, 기본값/|| 수정만 반영)
function mapBoxToOverlay(box){
  const vw = video.videoWidth, vh = video.videoHeight;
  if(!vw || !vh) return [0,0,0,0];
  const videoRect = video.getBoundingClientRect();
  const scaleX = videoRect.width / vw;
  const scaleY = videoRect.height / vh;
  const [x1,y1,x2,y2] = box;
  return [x1*scaleX, y1*scaleY, x2*scaleX, y2*scaleY];
}

// 모델 로드 (상대경로 우선)
async function loadModel(){
  const candidatePaths = ['./yolov8n.onnx', './model/yolov8n.onnx'];
  const opts = { executionProviders:['wasm','webgl'] };
  const statusEl = $('status');
  if (statusEl) statusEl.textContent = '모델 로드 상태: 로딩 시도 중...';

  let lastErr = null;
  for (const p of candidatePaths) {
    try {
      const resp = await fetch(p, {method:'GET'});
      if (!resp.ok) { lastErr = new Error('HTTP '+resp.status); continue; }
      const ab = await resp.arrayBuffer();
      modelSession = await ort.InferenceSession.create(ab, opts);
      modelLoaded = true;
      statusEl && (statusEl.textContent = `모델 로드 상태: 성공 (${p})`);
      inspectModelBtn && (inspectModelBtn.disabled = false);
      return;
    } catch (err) {
      lastErr = err;
      console.warn('모델 로드 실패 경로:', p, err);
    }
  }
  modelLoaded = false;
  statusEl && (statusEl.innerHTML = '모델 로드 상태: 실패 — <code>yolov8n.onnx</code> 파일을 프로젝트 루트 또는 <code>./model/</code>에 업로드하세요.');
  inspectModelBtn && (inspectModelBtn.disabled = true);
  console.error('모델을 찾지 못했습니다. 마지막 오류:', lastErr);
}
loadModel();

if (modelFileInput) {
  modelFileInput.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const ab = await f.arrayBuffer();
      const opts = { executionProviders:['wasm','webgl'] };
      modelSession = await ort.InferenceSession.create(ab, opts);
      modelLoaded = true;
      alert('업로드한 모델을 성공적으로 로드했습니다.');
    } catch (err) {
      console.error('업로드한 모델 로드 실패', err);
      modelLoaded = false;
      alert('업로드한 모델을 로드하지 못했습니다. 올바른 ONNX인지 확인하세요.');
    }
  });
}

if (completeROIsBtn) {
  bindMulti(completeROIsBtn, (e)=>{ e?.preventDefault?.(); switchTab(4); runDetectBtn?.click(); });
}
if (playResultsBtn) {
  bindMulti(playResultsBtn, (e)=>{ e?.preventDefault?.(); playResults(); switchTab(4); });
}

let playTimer = null;
function playResults(){
  if (!extractedFrames?.length) return;
  let idx = 0; const total = extractedFrames.length; const fps = getFpsValue();
  if (playTimer) clearInterval(playTimer);
  playTimer = setInterval(() => {
    const c = extractedFrames[idx];
    const displayW = overlay.clientWidth || video.clientWidth || 640;
    const displayH = overlay.clientHeight || video.clientHeight || 360;
    const dpr = window.devicePixelRatio || 1;
    overlay.width = Math.max(1, Math.round(displayW * dpr));
    overlay.height = Math.max(1, Math.round(displayH * dpr));
    overlay.style.width = displayW + 'px'; overlay.style.height = displayH + 'px';
    const drawCtx = overlay.getContext('2d');
    try{ drawCtx.setTransform(1,0,0,1,0,0); }catch{}
    drawCtx.clearRect(0,0,overlay.width,overlay.height);
    drawCtx.setTransform(dpr,0,0,dpr,0,0);
    try{ drawCtx.drawImage(c,0,0, c.width,c.height, 0,0, displayW,displayH); }catch(e){}

    const det = detectionsPerFrame[idx];
    if (det?.box) {
      const srcCssW = c._cssWidth || Math.round((c.width || displayW)/dpr);
      const srcCssH = c._cssHeight || Math.round((c.height || displayH)/dpr);
      const scaleX = displayW / (srcCssW || displayW);
      const scaleY = displayH / (srcCssH || displayH);
      const [x1,y1,x2,y2] = det.box;
      drawCtx.strokeStyle='#ff0066'; drawCtx.lineWidth=3;
      drawCtx.strokeRect(x1*scaleX, y1*scaleY, (x2-x1)*scaleX, (y2-y1)*scaleY);
    }
    idx++; if (idx>=total) idx=0;
  }, 1000 / fps);
}

// ROI 기반 단순 분석 (필요시)
async function analyzeByROI(){
  if (!roi && !frameROIs[currentFrameIndex]) { alert('분석할 ROI를 먼저 선택하세요'); return; }
  detectionsPerFrame = [];
  const fps = getFpsValue();
  const duration = video.duration || 0;
  const totalFrames = Math.floor(duration * fps);
  video.pause();
  for (let i=0;i<totalFrames;i++){
    const t = i/fps;
    await seekToTime(t);
    const r = frameROIs[i] || frameROIs[currentFrameIndex];
    if (r) {
      detectionsPerFrame.push({ time: video.currentTime, box:[r.x,r.y,r.x+r.w,r.y+r.h], score:1.0 });
    } else {
      detectionsPerFrame.push({ time: video.currentTime, box:null, score:0 });
    }
  }
  analyzeTrackData();
}

// YOLO 분석 (ROI 없는 프레임 자동 지정)
async function analyzeWithYOLO(){
  if (!modelLoaded) { alert('모델이 로드되어 있지 않습니다.'); return; }
  detectionsPerFrame = [];
  const fps = getFpsValue();
  const duration = video.duration || 0;
  const totalFrames = Math.floor(duration * fps);
  const confTh = getConfValue();
  video.pause();
  for (let i=0;i<totalFrames;i++){
    const t = i/fps;
    await seekToTime(t);
    const imgData = captureFrameImage();
    const { tensor, padInfo } = preprocessForYOLO(imgData, 640);
    const inputName = modelSession.inputNames[0];
    const feeds = {}; feeds[inputName] = tensor;
    let output = null;
    try {
      const results = await modelSession.run(feeds);
      const outName = modelSession.outputNames[0];
      output = results[outName];
    } catch (err) {
      console.error('모델 실행 중 오류', err);
      alert('모델 실행 실패'); return;
    }
    const detections = parseYoloOutput(output, padInfo, confTh);
    let chosen = null;
    const roiHere = frameROIs[i];
    if (roiHere && detections.length) {
      const vroi = [roiHere.x, roiHere.y, roiHere.x+roiHere.w, roiHere.y+roiHere.h];
      let bestIoU=0;
      for (const d of detections) {
        const iou = boxIoU(d.box, vroi);
        if (iou > bestIoU){ bestIoU=iou; chosen=d; }
      }
      if (bestIoU < 0.05) chosen = detections[0];
    } else if (detections.length) {
      chosen = detections[0];
    }
    if (chosen) detectionsPerFrame.push({ time:video.currentTime, box:chosen.box, score:chosen.score });
    else detectionsPerFrame.push({ time:video.currentTime, box:null, score:0 });

    if (i%10===0) drawOverlay();
  }
  analyzeTrackData();
}

if (runDetectBtn) bindMulti(runDetectBtn, async (e)=>{
  e?.preventDefault?.();
  if (!modelLoaded) {
    const ok = confirm('YOLO 모델이 로드되지 않았습니다. ROI 기반 수동 분석을 진행하시겠습니까?');
    if (!ok) return;
    analyzeByROI();
  } else {
    await analyzeWithYOLO();
  }
});

// 프레임 캡쳐/전처리/출력 파서 (기존 로직 유지)
function captureFrameImage(videoEl){
  const src = videoEl || video;
  const tmp = document.createElement('canvas');
  const cssW = (src && src.videoWidth) || Math.max(320, (src && src.clientWidth) || 320);
  const cssH = (src && src.videoHeight) || Math.max(240, (src && src.clientHeight) || 240);
  const dpr = window.devicePixelRatio || 1;
  tmp.width = Math.max(1, Math.round(cssW * dpr));
  tmp.height = Math.max(1, Math.round(cssH * dpr));
  tmp.style.width = cssW + 'px'; tmp.style.height = cssH + 'px';
  tmp._cssWidth = cssW; tmp._cssHeight = cssH; tmp._dpr = dpr;
  const tctx = tmp.getContext('2d');
  try { tctx.setTransform(dpr,0,0,dpr,0,0); tctx.drawImage(src, 0,0, cssW, cssH); }
  catch (err) { tctx.setTransform(1,0,0,1,0,0); tctx.fillStyle='rgb(100,100,100)'; tctx.fillRect(0,0,tmp.width,tmp.height); }
  return tmp;
}

function preprocessForYOLO(canvas, size){
  const iw = canvas.width, ih = canvas.height;
  const scale = Math.min(size/iw, size/ih);
  const nw = Math.round(iw*scale), nh = Math.round(ih*scale);
  const padW = size - nw, padH = size - nh;
  const dx = Math.floor(padW/2), dy = Math.floor(padH/2);
  const tmp = document.createElement('canvas'); tmp.width=size; tmp.height=size;
  const tctx = tmp.getContext('2d');
  tctx.fillStyle = 'rgb(114,114,114)'; tctx.fillRect(0,0,size,size);
  tctx.drawImage(canvas, 0,0,iw,ih, dx,dy, nw, nh);
  const id = tctx.getImageData(0,0,size,size).data;
  const float32 = new Float32Array(1*3*size*size);
  for (let y=0;y<size;y++){
    for (let x=0;x<size;x++){
      const i = (y*size + x)*4;
      const r = id[i]/255, g = id[i+1]/255, b = id[i+2]/255;
      const idx = y*size + x;
      float32[idx] = r;
      float32[size*size + idx] = g;
      float32[2*size*size + idx] = b;
    }
  }
  const tensor = new ort.Tensor('float32', float32, [1,3,size,size]);
  return { tensor, padInfo:{dx,dy,scale} };
}

function parseYoloOutput(outputTensor, padInfo, confThreshold){
  const results = [];
  if (!outputTensor) return results;
  const data = outputTensor.data;
  const shape = outputTensor.dims || [];
  let N=0, C=0, offsetRow=0;
  if (shape.length===3 && shape[0]===1){ N = shape[1]; C = shape[2]; offsetRow = C; }
  else if (shape.length===2){ N = shape[0]; C = shape[1]; offsetRow = C; }
  else { console.warn('Unexpected model output shape', shape); return results; }
  for (let i=0;i<N;i++){
    const base = i*offsetRow;
    if (base + Math.min(6,C) > data.length) break;
    const cx = data[base + 0];
    const cy = data[base + 1];
    const w  = data[base + 2];
    const h  = data[base + 3];
    const objConf = (C>4) ? data[base + 4] : 1.0;
    let cls = 0, maxp = 1.0;
    if (C > 5){
      maxp = 0;
      for (let c=5;c<C;c++){ const p = data[base + c]; if (p>maxp){ maxp=p; cls=c-5; } }
    }
    const score = objConf * maxp;
    if (score < confThreshold) continue;
    const x1 = (cx - w/2 - padInfo.dx)/padInfo.scale;
    const y1 = (cy - h/2 - padInfo.dy)/padInfo.scale;
    const x2 = (cx + w/2 - padInfo.dx)/padInfo.scale;
    const y2 = (cy + h/2 - padInfo.dy)/padInfo.scale;
    results.push({ box:[x1,y1,x2,y2], score, class:cls });
  }
  results.sort((a,b)=>b.score-a.score);
  return nms(results, 0.45);
}
function nms(boxes, iouThreshold){
  const out = [];
  for (const b of boxes){
    let keep = true;
    for (const o of out){ if (boxIoU(o.box, b.box) > iouThreshold) { keep=false; break; } }
    if (keep) out.push(b);
  }
  return out;
}
function boxIoU(a,b){
  if (!a || !b) return 0;
  const [ax1,ay1,ax2,ay2] = a; const [bx1,by1,bx2,by2] = b;
  const ix1 = Math.max(ax1,bx1), iy1 = Math.max(ay1,by1);
  const ix2 = Math.min(ax2,bx2), iy2 = Math.min(ay2,by2);
  const iw = Math.max(0, ix2-ix1), ih = Math.max(0, iy2-iy1);
  const inter = iw*ih;
  const aarea = Math.max(0,ax2-ax1)*Math.max(0,ay2-ay1);
  const barea = Math.max(0,bx2-bx1)*Math.max(0,by2-by1);
  return inter / (aarea + barea - inter + 1e-6);
}

function seekToTime(t, videoEl){
  const src = videoEl || video;
  return new Promise((res)=>{
    let done = false;
    const startMs = Date.now();
    const clearAll = () => {
      try{ src.removeEventListener('seeked', onseek); src.removeEventListener('timeupdate', ontime); }catch{}
    };
    const onseek = ()=>{ if(done) return; done=true; clearTimeout(timer); clearAll(); res(); };
    const ontime = ()=>{ if(done) return; done=true; clearTimeout(timer); clearAll(); res(); };
    src.addEventListener('seeked', onseek);
    src.addEventListener('timeupdate', ontime);
    try { src.currentTime = Math.min(src.duration || t, t); } catch {}
    const timer = setTimeout(()=>{ if(!done){ done=true; clearAll(); res(); } }, 3000);
  });
}

function analyzeTrackData(){
  const points = [];
  for (const f of detectionsPerFrame){
    if (f.box){
      const [x1,y1,x2,y2] = f.box; const cx=(x1+x2)/2; const cy=(y1+y2)/2;
      points.push({t:f.time, x:cx, y:cy});
    } else {
      points.push({t:f.time, x:null, y:null});
    }
  }
  const speeds = [], accs = [];
  for (let i=0;i<points.length;i++){
    if (i===0){ speeds.push(null); accs.push(null); continue; }
    const p0 = points[i-1], p1 = points[i];
    if (p0.x==null || p1.x==null){ speeds.push(null); accs.push(null); continue; }
    const dt = p1.t - p0.t || (1/getFpsValue());
    const distPx = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const speed = (distPx / dt) / getScaleValue(); // 단위/초
    speeds.push(speed);
    if (i===1){ accs.push(null); continue; }
    const prevSpeed = speeds[i-1] || 0;
    const acc = (speed - prevSpeed)/dt;
    accs.push(acc);
  }

  drawCharts(points, speeds);
  analysisResult = { points, speeds, accs };
  drawOverlay();
  alert('분석이 완료되었습니다. 결과를 시각화했습니다.');
}

let analysisResult = null;

function drawCharts(points, speeds){
  const labels = points.map(p=>p.t.toFixed(2));
  const xs = points.map(p=>p.x!=null ? (p.x/getScaleValue()) : null);
  const ys = points.map(p=>p.y!=null ? (p.y/getScaleValue()) : null);
  const speedData = speeds.map(s=>s || 0);

  if (posChart) posChart.destroy();
  const posCtx = document.getElementById('posChart').getContext('2d');
  posChart = new Chart(posCtx, {
    type:'line', data:{ labels, datasets:[
      {label:'X (단위)', data:xs, borderColor:'#4fd1c5', tension:0.2, spanGaps:true},
      {label:'Y (단위)', data:ys, borderColor:'#f97316', tension:0.2, spanGaps:true}
    ]}, options:{ responsive:true, maintainAspectRatio:false }
  });

  if (velChart) velChart.destroy();
  const velCtx = document.getElementById('velChart').getContext('2d');
  velChart = new Chart(velCtx, {
    type:'line', data:{ labels, datasets:[
      {label:'Speed (단위/초)', data:speedData, borderColor:'#60a5fa', tension:0.2, spanGaps:true}
    ]}, options:{ responsive:true, maintainAspectRatio:false }
  });
}

if (exportCSVBtn) bindMulti(exportCSVBtn, (e)=>{
  e?.preventDefault?.();
  if (!analysisResult){ alert('분석 후 내보내기 하세요.'); return; }
  const rows = [['frame','time_s','x_px','y_px','x_unit','y_unit','speed_unit_s','acc_unit_s2']];
  for (let i=0;i<detectionsPerFrame.length;i++){
    const d = detectionsPerFrame[i];
    const a = analysisResult.points[i];
    const s = analysisResult.speeds[i] ?? '';
    const acc = analysisResult.accs[i] ?? '';
    const x_px = a.x ?? '';
    const y_px = a.y ?? '';
    const x_u = a.x!=null ? (a.x/getScaleValue()).toFixed(4) : '';
    const y_u = a.y!=null ? (a.y/getScaleValue()).toFixed(4) : '';
    rows.push([i, (d.time ?? 0).toFixed(4), x_px, y_px, x_u, y_u, s, acc]);
  }
  const csv = rows.map(r=>r.join(',')).join('\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const aTag = document.createElement('a'); aTag.href = url; aTag.download = 'analysis.csv'; aTag.click();
  URL.revokeObjectURL(url);
});

// 제목 더블클릭 시 모델 재로드
const _hdrTitle = document.querySelector('header h1');
_hdrTitle?.addEventListener('dblclick', () => { if (confirm('모델을 다시 로드하시겠습니까?')) loadModel(); });

// 초기 오버레이 루프 (디버그용)
setInterval(()=>{ drawOverlay(); }, 200);

// 초기화 안내
userLog('앱 초기화 완료 — 업로드→표시→추출 경로가 활성화되었습니다.');
