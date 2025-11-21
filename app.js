
// Motion Tracker — clean ASCII, DOMContentLoaded wrapper

document.addEventListener('DOMContentLoaded', function(){
  'use strict';
  var video = document.getElementById('videoMain');
  var overlay = document.getElementById('overlay');
  var framePreview = document.getElementById('framePreview');
  var statusEl = document.getElementById('status');
  var tabBtn1 = document.getElementById('tabBtn1');
  var tabBtn2 = document.getElementById('tabBtn2');
  var tabBtn3 = document.getElementById('tabBtn3');
  var tabBtn4 = document.getElementById('tabBtn4');
  var controls1 = document.getElementById('controls-1');
  var controls2 = document.getElementById('controls-2');
  var controls3 = document.getElementById('controls-3');
  var controls4 = document.getElementById('controls-4');
  var videoFile = document.getElementById('videoFile');
  var startCameraBtn = document.getElementById('startCamera');
  var recordToggleBtn = document.getElementById('recordToggle');
  var fpsInput = document.getElementById('fpsInput');
  var confInput = document.getElementById('confInput');
  var scaleInput = document.getElementById('scaleInput');
  var extractFramesBtn = document.getElementById('extractFramesBtn');
  var extractProgress = document.getElementById('extractProgress');
  var progressBar = document.getElementById('progressBar');
  var progressText = document.getElementById('progressText');
  var frameNav = document.getElementById('frameNav');
  var prevFrameBtn = document.getElementById('prevFrame');
  var nextFrameBtn = document.getElementById('nextFrame');
  var frameIdxEl = document.getElementById('frameIdx');
  var runDetectBtn = document.getElementById('runDetectBtn');
  var playResultsBtn = document.getElementById('playResultsBtn');
  var exportCSVBtn = document.getElementById('exportCSV');
  var completeROIsBtn = document.getElementById('completeROIs');

  var modelSession = null; var modelLoaded = false;
  var detectionsPerFrame = []; var extractedFrames = []; var currentFrameIndex = 0;
  var frameROIs = []; var roi = null; var isDrawingROI = false; var startX=0, startY=0;
  var posChart=null, velChart=null; var scalePxPerUnit = 100;
  var currentStream=null, mediaRecorder=null, recordedChunks=[];
  var isExtracting=false, playTimer=null;

  function numOr(v, def){ var n = Number(v); return isFinite(n) ? n : def; }
  function getFps(){ return Math.max(1, numOr(fpsInput && fpsInput.value, 10)); }
  function getConf(){ var v = numOr(confInput && confInput.value, 0.3); return Math.max(0, Math.min(1, v)); }
  function getScale(){ var v = numOr(scaleInput && scaleInput.value, 100); scalePxPerUnit = Math.max(0.0001, v); return scalePxPerUnit; }
  function switchTab(n){ var btns=[tabBtn1,tabBtn2,tabBtn3,tabBtn4]; var ctrls=[controls1,controls2,controls3,controls4]; for(var i=0;i<btns.length;i++){ if(btns[i]){ if(i+1===n) btns[i].classList.add('active'); else btns[i].classList.remove('active'); } if(ctrls[i]) ctrls[i].style.display=(i+1===n)?'':'none'; } }
  function setProgress(p){ if(progressBar) progressBar.style.width=p+'%'; if(progressText) progressText.textContent=p+'%'; }
  function resizeOverlay(){ if(!overlay||!video) return; var dpr=window.devicePixelRatio||1; var w=Math.max(1,Math.round(video.clientWidth*dpr)); var h=Math.max(1,Math.round(video.clientHeight*dpr)); overlay.width=w; overlay.height=h; overlay.style.width=video.clientWidth+'px'; overlay.style.height=video.clientHeight+'px'; }
  window.addEventListener('resize', resizeOverlay); video.addEventListener('loadedmetadata', resizeOverlay);
  function drawOverlayFrame(c){ var displayW=overlay.clientWidth||video.clientWidth||640; var displayH=overlay.clientHeight||video.clientHeight||360; var dpr=window.devicePixelRatio||1; var ctx=overlay.getContext('2d'); try{ ctx.setTransform(1,0,0,1,0,0); }catch(e){} ctx.clearRect(0,0,overlay.width,overlay.height); ctx.setTransform(dpr,0,0,dpr,0,0); if(c){ try{ ctx.drawImage(c,0,0,c.width,c.height,0,0,displayW,displayH); }catch(e){} } if(roi){ ctx.strokeStyle='#00ff88'; ctx.lineWidth=2; ctx.setLineDash([6,4]); ctx.strokeRect(roi.x, roi.y, roi.w, roi.h); ctx.setLineDash([]); } var det=detectionsPerFrame[currentFrameIndex]; if(det&&det.box){ var srcCssW=c?(c._cssWidth||displayW):displayW; var srcCssH=c?(c._cssHeight||displayH):displayH; var sx=displayW/srcCssW; var sy=displayH/srcCssH; var x1=det.box[0]*sx, y1=det.box[1]*sy; var w=(det.box[2]-det.box[0])*sx, h=(det.box[3]-det.box[1])*sy; ctx.strokeStyle='#ff0066'; ctx.lineWidth=3; ctx.strokeRect(x1,y1,w,h); } }

  tabBtn1.addEventListener('click', function(){ switchTab(1); });
  tabBtn2.addEventListener('click', function(){ switchTab(2); });
  tabBtn3.addEventListener('click', function(){ switchTab(3); });
  tabBtn4.addEventListener('click', function(){ switchTab(4); });

  if(videoFile){ videoFile.addEventListener('change', function(e){ var f=e.target.files&&e.target.files[0]; if(!f) return; var url=URL.createObjectURL(f); framePreview.style.display='none'; framePreview.style.visibility='hidden'; overlay.style.display='none'; overlay.style.visibility='hidden'; video.srcObject=null; video.src=url; video.style.display='block'; video.style.visibility='visible'; video.controls=true; video.muted=false; video.playsInline=true; video.addEventListener('loadedmetadata', function once(){ video.removeEventListener('loadedmetadata', once); resizeOverlay(); video.play().catch(function(){}); }, {once:true}); if(extractFramesBtn) extractFramesBtn.disabled=false; switchTab(2); }); }

  if(startCameraBtn){ startCameraBtn.addEventListener('click', function(){ navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false }).then(function(s){ currentStream=s; video.srcObject=s; video.muted=true; video.playsInline=true; video.controls=false; return video.play().catch(function(){}); }).then(function(){ if(typeof MediaRecorder!=='undefined'){ recordToggleBtn.style.display=''; recordToggleBtn.disabled=false; } }).catch(function(err){ alert('카메라 접근 실패: '+err.message); }); }); }
  if(recordToggleBtn){ recordToggleBtn.addEventListener('click', function(){ if(!currentStream) return; if(typeof MediaRecorder==='undefined'){ alert('이 브라우저는 녹화를 지원하지 않습니다.'); return; } if(!mediaRecorder||mediaRecorder.state==='inactive'){ recordedChunks=[]; mediaRecorder=new MediaRecorder(currentStream); mediaRecorder.ondataavailable=function(e){ if(e.data&&e.data.size) recordedChunks.push(e.data); }; mediaRecorder.onstop=function(){ var blob=new Blob(recordedChunks,{type:'video/webm'}); var url=URL.createObjectURL(blob); video.srcObject=null; video.src=url; video.muted=false; video.play().catch(function(){}); if(extractFramesBtn) extractFramesBtn.disabled=false; switchTab(2); }; mediaRecorder.start(); recordToggleBtn.textContent='녹화 중지'; } else { mediaRecorder.stop(); recordToggleBtn.textContent='녹화 시작'; } }); }

  function setExtractUIRunning(r){ if(extractProgress) extractProgress.style.display=r?'':'none'; }
  function extractFrames(){ if(isExtracting) return; var srcUrl=video.currentSrc||video.src; if(!srcUrl){ alert('비디오를 먼저 업로드/촬영하세요.'); return; } isExtracting=true; extractedFrames=[]; currentFrameIndex=0; setProgress(0); setExtractUIRunning(true); var cap=document.createElement('video'); cap.muted=true; cap.preload='auto'; cap.crossOrigin='anonymous'; cap.src=srcUrl; cap.addEventListener('loadedmetadata', function(){ var fps=getFps(); var duration=cap.duration||video.duration||0; var total=Math.max(1, Math.floor(duration*fps)); var dpr=window.devicePixelRatio||1; var cssW=cap.videoWidth||640; var cssH=cap.videoHeight||360; var i=0; function step(){ if(i>=total){ setExtractUIRunning(false); setProgress(100); framePreview.style.display=''; framePreview.style.visibility='visible'; overlay.style.display=''; overlay.style.visibility='visible'; showFrame(0); frameNav.style.display='flex'; isExtracting=false; if(extractFramesBtn) extractFramesBtn.disabled=false; switchTab(3); return; } var t=Math.min(duration, i/fps); cap.currentTime=t; cap.addEventListener('seeked', function once(){ cap.removeEventListener('seeked', once); var c=document.createElement('canvas'); c._cssWidth=cssW; c._cssHeight=cssH; c._dpr=dpr; c.width=Math.round(cssW*dpr); c.height=Math.round(cssH*dpr); var ctx=c.getContext('2d'); try{ ctx.setTransform(dpr,0,0,dpr,0,0); ctx.drawImage(cap,0,0,cssW,cssH); }catch(e){ ctx.fillStyle='#333'; ctx.fillRect(0,0,cssW,cssH); } extractedFrames.push(c); setProgress(Math.round(((i+1)/total)*100)); i++; step(); }, {once:true}); } step(); }, {once:true}); }
  if(extractFramesBtn){ extractFramesBtn.addEventListener('click', function(){ extractFramesBtn.disabled=true; extractFrames(); }); }

  function showFrame(idx){ if(!extractedFrames.length) return; currentFrameIndex=Math.max(0, Math.min(idx, extractedFrames.length-1)); var c=extractedFrames[currentFrameIndex]; var displayW=overlay.clientWidth||video.clientWidth||640; var displayH=overlay.clientHeight||video.clientHeight||360; var dpr=window.devicePixelRatio||1; overlay.width=Math.max(1,Math.round(displayW*dpr)); overlay.height=Math.max(1,Math.round(displayH*dpr)); overlay.style.width=displayW+'px'; overlay.style.height=displayH+'px'; try{ framePreview.src=c.toDataURL('image/png'); framePreview.style.width=displayW+'px'; framePreview.style.height=displayH+'px'; framePreview.style.objectFit='contain'; framePreview.style.display=''; framePreview.style.visibility='visible'; overlay.style.display=''; overlay.style.visibility='visible'; }catch(e){} drawOverlayFrame(c); if(frameIdxEl) frameIdxEl.textContent='Frame '+(currentFrameIndex+1)+' / '+extractedFrames.length; }
  if(prevFrameBtn){ prevFrameBtn.addEventListener('click', function(){ if(!extractedFrames.length) return; showFrame(Math.max(0, currentFrameIndex-1)); }); }
  if(nextFrameBtn){ nextFrameBtn.addEventListener('click', function(){ if(!extractedFrames.length) return; showFrame(Math.min(extractedFrames.length-1, currentFrameIndex+1)); }); }

  function overlayToCanvasRect(ov){ var c=extractedFrames[currentFrameIndex]; var dpr=window.devicePixelRatio||1; var srcCssW=c?(c._cssWidth||Math.round((c.width||overlay.clientWidth)/dpr)):overlay.clientWidth; var srcCssH=c?(c._cssHeight||Math.round((c.height||overlay.clientHeight)/dpr)):overlay.clientHeight; var sx=srcCssW/overlay.clientWidth; var sy=srcCssH/overlay.clientHeight; return {x:ov.x*sx, y:ov.y*sy, w:ov.w*sx, h:ov.h*sy}; }
  overlay.addEventListener('pointerdown', function(e){ var r=overlay.getBoundingClientRect(); startX=e.clientX-r.left; startY=e.clientY-r.top; roi={x:startX,y:startY,w:0,h:0}; isDrawingROI=true; drawOverlayFrame(extractedFrames[currentFrameIndex]||null); });
  overlay.addEventListener('pointermove', function(e){ if(!isDrawingROI||!roi) return; var r=overlay.getBoundingClientRect(); var x=e.clientX-r.left; var y=e.clientY-r.top; roi.w=x-roi.x; roi.h=y-roi.y; if(roi.w<0){ roi.x=x; roi.w=Math.abs(roi.w); } if(roi.h<0){ roi.y=y; roi.h=Math.abs(roi.h); } drawOverlayFrame(extractedFrames[currentFrameIndex]||null); });
  overlay.addEventListener('pointerup', function(){ if(!isDrawingROI||!roi) return; isDrawingROI=false; var saved=overlayToCanvasRect(roi); frameROIs[currentFrameIndex]=saved; switchTab(4); });
  if(completeROIsBtn){ completeROIsBtn.addEventListener('click', function(){ switchTab(4); if(runDetectBtn) runDetectBtn.click(); }); }

  function loadModel(){ if(statusEl) statusEl.textContent='모델 로드 상태: 로딩 시도 중...'; var paths=['./yolov8n.onnx','./model/yolov8n.onnx']; (function tryNext(i){ if(i>=paths.length){ modelLoaded=false; if(statusEl) statusEl.innerHTML='모델 로드 상태: 실패 — yolov8n.onnx 위치 확인'; return; } fetch(paths[i]).then(function(resp){ if(!resp.ok) throw new Error('HTTP '+resp.status); return resp.arrayBuffer(); }).then(function(ab){ return ort.InferenceSession.create(ab,{executionProviders:['wasm','webgl']}); }).then(function(sess){ modelSession=sess; modelLoaded=true; if(statusEl) statusEl.textContent='모델 로드 상태: 성공 ('+paths[i]+')'; }).catch(function(){ tryNext(i+1); }); })(0); }
  loadModel();
});
