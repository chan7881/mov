
(function(){
  // Elements
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

  // State
  var modelSession = null;
  var modelLoaded = false;
  var detectionsPerFrame = [];
  var extractedFrames = [];
  var currentFrameIndex = 0;
  var frameROIs = [];
  var roi = null;
  var isDrawingROI = false;
  var startX = 0, startY = 0;
  var posChart = null, velChart = null;
  var scalePxPerUnit = 100;
  var currentStream = null, mediaRecorder = null, recordedChunks = [];
  var isExtracting = false;
  var playTimer = null;

  // Helpers
  function numOr(v, def){ var n = Number(v); return isFinite(n) ? n : def; }
  function getFps(){ return Math.max(1, numOr(fpsInput && fpsInput.value, 10)); }
  function getConf(){ var v = numOr(confInput && confInput.value, 0.3); return Math.max(0, Math.min(1, v)); }
  function getScale(){ var v = numOr(scaleInput && scaleInput.value, 100); scalePxPerUnit = Math.max(0.0001, v); return scalePxPerUnit; }
  function switchTab(n){
    var btns = [tabBtn1,tabBtn2,tabBtn3,tabBtn4];
    var ctrls = [controls1,controls2,controls3,controls4];
    for (var i=0;i<btns.length;i++){
      if (btns[i]){ if (i+1===n) btns[i].classList.add('active'); else btns[i].classList.remove('active'); }
      if (ctrls[i]) ctrls[i].style.display = (i+1===n) ? '' : 'none';
    }
  }
  function setProgress(p){ if(progressBar) progressBar.style.width = p + '%'; if(progressText) progressText.textContent = p + '%'; }
  function resizeOverlay(){ if(!overlay||!video) return; var dpr=window.devicePixelRatio||1; var w=Math.max(1,Math.round(video.clientWidth*dpr)); var h=Math.max(1,Math.round(video.clientHeight*dpr)); overlay.width=w; overlay.height=h; overlay.style.width=video.clientWidth+'px'; overlay.style.height=video.clientHeight+'px'; }
  window.addEventListener('resize', resizeOverlay); video.addEventListener('loadedmetadata', resizeOverlay);
  function drawOverlayFrame(c){ var displayW = overlay.clientWidth || video.clientWidth || 640; var displayH = overlay.clientHeight || video.clientHeight || 360; var dpr=window.devicePixelRatio||1; var ctx=overlay.getContext('2d'); try{ ctx.setTransform(1,0,0,1,0,0); }catch(e){} ctx.clearRect(0,0,overlay.width,overlay.height); ctx.setTransform(dpr,0,0,dpr,0,0); if(c){ try{ ctx.drawImage(c,0,0,c.width,c.height,0,0,displayW,displayH); }catch(e){} } if(roi){ ctx.strokeStyle='#00ff88'; ctx.lineWidth=2; ctx.setLineDash([6,4]); ctx.strokeRect(roi.x, roi.y, roi.w, roi.h); ctx.setLineDash([]); }
    var det=detectionsPerFrame[currentFrameIndex]; if(det&&det.box){ var srcCssW=c?(c._cssWidth||displayW):displayW; var srcCssH=c?(c._cssHeight||displayH):displayH; var sx=displayW/srcCssW; var sy=displayH/srcCssH; var x1=det.box[0]*sx, y1=det.box[1]*sy; var w=(det.box[2]-det.box[0])*sx, h=(det.box[3]-det.box[1])*sy; ctx.strokeStyle='#ff0066'; ctx.lineWidth=3; ctx.strokeRect(x1,y1,w,h); } }

  // Tabs
  tabBtn1.addEventListener('click', function(){ switchTab(1); });
  tabBtn2.addEventListener('click', function(){ switchTab(2); });
  tabBtn3.addEventListener('click', function(){ switchTab(3); });
  tabBtn4.addEventListener('click', function(){ switchTab(4); });

  // Upload
  if(videoFile){ videoFile.addEventListener('change', function(e){ var f=e.target.files&&e.target.files[0]; if(!f) return; var url=URL.createObjectURL(f); framePreview.style.display='none'; framePreview.style.visibility='hidden'; overlay.style.display='none'; overlay.style.visibility='hidden'; video.srcObject=null; video.src=url; video.style.display='block'; video.style.visibility='visible'; video.controls=true; video.muted=false; video.playsInline=true; video.addEventListener('loadedmetadata', function once(){ video.removeEventListener('loadedmetadata', once); resizeOverlay(); video.play().catch(function(){}); }, {once:true}); if(extractFramesBtn) extractFramesBtn.disabled=false; switchTab(2); }); }

  // Camera
  if(startCameraBtn){ startCameraBtn.addEventListener('click', function(){ navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' }, audio:false }).then(function(s){ currentStream=s; video.srcObject=s; video.muted=true; video.playsInline=true; video.controls=false; return video.play().catch(function(){}); }).then(function(){ recordToggleBtn.style.display=''; recordToggleBtn.disabled=false; }).catch(function(err){ alert('카메라 접근 실패: '+err.message); }); }); }
  if(recordToggleBtn){ recordToggleBtn.addEventListener('click', function(){ if(!currentStream) return; if(!mediaRecorder||mediaRecorder.state==='inactive'){ recordedChunks=[]; mediaRecorder=new MediaRecorder(currentStream); mediaRecorder.ondataavailable=function(e){ if(e.data&&e.data.size) recordedChunks.push(e.data); }; mediaRecorder.onstop=function(){ var blob=new Blob(recordedChunks,{type:'video/webm'}); var url=URL.createObjectURL(blob); video.srcObject=null; video.src=url; video.muted=false; video.play().catch(function(){}); if(extractFramesBtn) extractFramesBtn.disabled=false; switchTab(2); }; mediaRecorder.start(); recordToggleBtn.textContent='녹화 중지'; } else { mediaRecorder.stop(); recordToggleBtn.textContent='녹화 시작'; } }); }

  // Frame extraction
  function setExtractUIRunning(r){ if(extractProgress) extractProgress.style.display=r?'':'none'; }
  function extractFrames(){ if(isExtracting) return; var srcUrl=video.currentSrc||video.src; if(!srcUrl){ alert('비디오를 먼저 업로드/촬영하세요.'); return; } isExtracting=true; extractedFrames=[]; currentFrameIndex=0; setProgress(0); setExtractUIRunning(true); var cap=document.createElement('video'); cap.muted=true; cap.preload='auto'; cap.crossOrigin='anonymous'; cap.src=srcUrl; cap.addEventListener('loadedmetadata', function(){ var fps=getFps(); var duration=cap.duration||video.duration||0; var total=Math.max(1, Math.floor(duration*fps)); var dpr=window.devicePixelRatio||1; var cssW=cap.videoWidth||640; var cssH=cap.videoHeight||360; var i=0; function step(){ if(i>=total){ setExtractUIRunning(false); setProgress(100); framePreview.style.display=''; framePreview.style.visibility='visible'; overlay.style.display=''; overlay.style.visibility='visible'; showFrame(0); frameNav.style.display='flex'; isExtracting=false; if(extractFramesBtn) extractFramesBtn.disabled=false; switchTab(3); return; } var t=Math.min(duration, i/fps); cap.currentTime=t; cap.addEventListener('seeked', function once(){ cap.removeEventListener('seeked', once); var c=document.createElement('canvas'); c._cssWidth=cssW; c._cssHeight=cssH; c._dpr=dpr; c.width=Math.round(cssW*dpr); c.height=Math.round(cssH*dpr); var ctx=c.getContext('2d'); try{ ctx.setTransform(dpr,0,0,dpr,0,0); ctx.drawImage(cap,0,0,cssW,cssH); }catch(e){ ctx.fillStyle='#333'; ctx.fillRect(0,0,cssW,cssH); } extractedFrames.push(c); setProgress(Math.round(((i+1)/total)*100)); i++; step(); }, {once:true}); } step(); }, {once:true}); }
  if(extractFramesBtn){ extractFramesBtn.addEventListener('click', function(){ extractFramesBtn.disabled=true; extractFrames(); }); }

  function showFrame(idx){ if(!extractedFrames.length) return; currentFrameIndex=Math.max(0, Math.min(idx, extractedFrames.length-1)); var c=extractedFrames[currentFrameIndex]; var displayW=overlay.clientWidth||video.clientWidth||640; var displayH=overlay.clientHeight||video.clientHeight||360; var dpr=window.devicePixelRatio||1; overlay.width=Math.max(1,Math.round(displayW*dpr)); overlay.height=Math.max(1,Math.round(displayH*dpr)); overlay.style.width=displayW+'px'; overlay.style.height=displayH+'px'; try{ framePreview.src=c.toDataURL('image/png'); framePreview.style.width=displayW+'px'; framePreview.style.height=displayH+'px'; framePreview.style.objectFit='contain'; framePreview.style.display=''; framePreview.style.visibility='visible'; overlay.style.display=''; overlay.style.visibility='visible'; }catch(e){} drawOverlayFrame(c); if(frameIdxEl) frameIdxEl.textContent='Frame '+(currentFrameIndex+1)+' / '+extractedFrames.length; }
  if(prevFrameBtn){ prevFrameBtn.addEventListener('click', function(){ if(!extractedFrames.length) return; showFrame(Math.max(0, currentFrameIndex-1)); }); }
  if(nextFrameBtn){ nextFrameBtn.addEventListener('click', function(){ if(!extractedFrames.length) return; showFrame(Math.min(extractedFrames.length-1, currentFrameIndex+1)); }); }

  // ROI drawing
  function overlayToCanvasRect(ov){ var c=extractedFrames[currentFrameIndex]; var dpr=window.devicePixelRatio||1; var srcCssW=c?(c._cssWidth||Math.round((c.width||overlay.clientWidth)/dpr)):overlay.clientWidth; var srcCssH=c?(c._cssHeight||Math.round((c.height||overlay.clientHeight)/dpr)):overlay.clientHeight; var sx=srcCssW/overlay.clientWidth; var sy=srcCssH/overlay.clientHeight; return {x:ov.x*sx, y:ov.y*sy, w:ov.w*sx, h:ov.h*sy}; }
  overlay.addEventListener('pointerdown', function(e){ var r=overlay.getBoundingClientRect(); startX=e.clientX-r.left; startY=e.clientY-r.top; roi={x:startX,y:startY,w:0,h:0}; isDrawingROI=true; drawOverlayFrame(extractedFrames[currentFrameIndex]||null); });
  overlay.addEventListener('pointermove', function(e){ if(!isDrawingROI||!roi) return; var r=overlay.getBoundingClientRect(); var x=e.clientX-r.left; var y=e.clientY-r.top; roi.w=x-roi.x; roi.h=y-roi.y; if(roi.w<0){ roi.x=x; roi.w=Math.abs(roi.w); } if(roi.h<0){ roi.y=y; roi.h=Math.abs(roi.h); } drawOverlayFrame(extractedFrames[currentFrameIndex]||null); });
  overlay.addEventListener('pointerup', function(){ if(!isDrawingROI||!roi) return; isDrawingROI=false; var saved=overlayToCanvasRect(roi); frameROIs[currentFrameIndex]=saved; switchTab(4); });
  if(completeROIsBtn){ completeROIsBtn.addEventListener('click', function(){ switchTab(4); if(runDetectBtn) runDetectBtn.click(); }); }

  // Model load
  function loadModel(){ if(statusEl) statusEl.textContent='모델 로드 상태: 로딩 시도 중...'; var paths=['./yolov8n.onnx','./model/yolov8n.onnx','../yolov8n.onnx','../model/yolov8n.onnx']; (function tryNext(i){ if(i>=paths.length){ modelLoaded=false; if(statusEl) statusEl.innerHTML='모델 로드 상태: 실패 — <code>yolov8n.onnx</code> 위치를 확인'; return; } fetch(paths[i]).then(function(resp){ if(!resp.ok) throw new Error('HTTP '+resp.status); return resp.arrayBuffer(); }).then(function(ab){ return ort.InferenceSession.create(ab,{executionProviders:['wasm','webgl']}); }).then(function(sess){ modelSession=sess; modelLoaded=true; if(statusEl) statusEl.textContent='모델 로드 상태: 성공 ('+paths[i]+')'; }).catch(function(){ tryNext(i+1); }); })(0); }
  loadModel();

  // YOLO detection
  function captureFrameCanvas(){ var tmp=document.createElement('canvas'); var cssW=video.videoWidth||Math.max(320, video.clientWidth||320); var cssH=video.videoHeight||Math.max(240, video.clientHeight||240); var dpr=window.devicePixelRatio||1; tmp.width=Math.max(1,Math.round(cssW*dpr)); tmp.height=Math.max(1,Math.round(cssH*dpr)); tmp._cssWidth=cssW; tmp._cssHeight=cssH; tmp._dpr=dpr; var tctx=tmp.getContext('2d'); try{ tctx.setTransform(dpr,0,0,dpr,0,0); tctx.drawImage(video,0,0,cssW,cssH); }catch(e){ tctx.setTransform(1,0,0,1,0,0); tctx.fillStyle='#666'; tctx.fillRect(0,0,tmp.width,tmp.height); } return tmp; }
  function preprocess(canvas, size){ var iw=canvas.width, ih=canvas.height; var sc=Math.min(size/iw, size/ih); var nw=Math.round(iw*sc), nh=Math.round(ih*sc); var dx=Math.floor((size-nw)/2), dy=Math.floor((size-nh)/2); var tmp=document.createElement('canvas'); tmp.width=size; tmp.height=size; var ctx=tmp.getContext('2d'); ctx.fillStyle='rgb(114,114,114)'; ctx.fillRect(0,0,size,size); ctx.drawImage(canvas,0,0,iw,ih, dx,dy, nw,nh); var id=ctx.getImageData(0,0,size,size).data; var f32=new Float32Array(3*size*size); for(var y=0;y<size;y++){ for(var x=0;x<size;x++){ var i=(y*size+x)*4; var r=id[i]/255, g=id[i+1]/255, b=id[i+2]/255; var idx=y*size+x; f32[idx]=r; f32[size*size+idx]=g; f32[2*size*size+idx]=b; } } var tensor=new ort.Tensor('float32', f32, [1,3,size,size]); return {tensor:tensor, padInfo:{dx:dx, dy:dy, scale:sc}}; }
  function iou(a,b){ if(!a||!b) return 0; var ax1=a[0],ay1=a[1],ax2=a[2],ay2=a[3]; var bx1=b[0],by1=b[1],bx2=b[2],by2=b[3]; var ix1=Math.max(ax1,bx1), iy1=Math.max(ay1,by1); var ix2=Math.min(ax2,bx2), iy2=Math.min(ay2,by2); var iw=Math.max(0,ix2-ix1), ih=Math.max(0,iy2-iy1); var inter=iw*ih; var aarea=Math.max(0,ax2-ax1)*Math.max(0,ay2-ay1); var barea=Math.max(0,bx2-bx1)*Math.max(0,by2-by1); return inter/(aarea+barea-inter+1e-6); }
  function sortNms(list,thr){ var out=[]; list.sort(function(a,b){return b.score-a.score;}); for(var i=0;i<list.length;i++){ var keep=true; for(var j=0;j<out.length;j++){ if(iou(list[i].box, out[j].box)>thr){ keep=false; break; } } if(keep) out.push(list[i]); } return out; }
  function parseOut(t, pad, conf){ var res=[]; if(!t) return res; var data=t.data; var dims=t.dims||[]; var N=0,C=0,stride=0; if(dims.length===3&&dims[0]===1){ N=dims[1]; C=dims[2]; stride=C; } else if(dims.length===2){ N=dims[0]; C=dims[1]; stride=C; } else { return res; } for(var i=0;i<N;i++){ var base=i*stride; var cx=data[base+0], cy=data[base+1], w=data[base+2], h=data[base+3]; var obj=(C>4)?data[base+4]:1.0; var cls=1.0; if(C>5){ var maxp=0; for(var c=5;c<C;c++){ if(data[base+c]>maxp) maxp=data[base+c]; } cls=maxp; } var score=obj*cls; if(score<conf) continue; var x1=(cx-w/2-pad.dx)/pad.scale; var y1=(cy-h/2-pad.dy)/pad.scale; var x2=(cx+w/2-pad.dx)/pad.scale; var y2=(cy+h/2-pad.dy)/pad.scale; res.push({box:[x1,y1,x2,y2], score:score}); } return sortNms(res, 0.45); }
  function seekTo(t){ return new Promise(function(res){ var done=false; function clear(){ try{ video.removeEventListener('seeked',onseek); video.removeEventListener('timeupdate',ontime); }catch(e){} } function onseek(){ if(done) return; done=true; clearTimeout(timer); clear(); res(); } function ontime(){ if(done) return; done=true; clearTimeout(timer); clear(); res(); } video.addEventListener('seeked',onseek); video.addEventListener('timeupdate',ontime); try{ video.currentTime=Math.min(video.duration||t, t); }catch(e){} var timer=setTimeout(function(){ if(!done){ done=true; clear(); res(); } },3000); }); }
  function runYOLO(){ if(!modelLoaded){ alert('모델이 로드되지 않았습니다.'); return; } detectionsPerFrame=[]; var fps=getFps(); var duration=video.duration||0; var total=(extractedFrames.length>0)?extractedFrames.length:Math.floor(duration*fps); var confTh=getConf(); var i=0; function step(){ if(i>=total){ analyzeTrack(); switchTab(4); return; } var src=null; if(extractedFrames.length>0){ src=extractedFrames[i]; runOnce(src); } else { seekTo(i/fps).then(function(){ src=captureFrameCanvas(); runOnce(src); }); } } function runOnce(src){ var prep=preprocess(src, 640); var feeds={}; feeds[modelSession.inputNames[0]]=prep.tensor; modelSession.run(feeds).then(function(out){ var dets=parseOut(out[modelSession.outputNames[0]], prep.padInfo, confTh); var chosen=null; var roiHere=frameROIs[i]; if(roiHere && dets.length){ var rb=[roiHere.x,roiHere.y,roiHere.x+roiHere.w,roiHere.y+roiHere.h]; var best=0; for(var k=0;k<dets.length;k++){ var v=iou(dets[k].box, rb); if(v>best){ best=v; chosen=dets[k]; } } if(best<0.05) chosen=dets[0]; } else if(dets.length){ chosen=dets[0]; } var t=(video.currentTime||i/fps); if(chosen) detectionsPerFrame.push({time:t, box:chosen.box, score:chosen.score}); else detectionsPerFrame.push({time:t, box:null, score:0}); i++; if(i%5===0) drawOverlayFrame(src); step(); }).catch(function(err){ alert('모델 실행 오류: '+err.message); }); } step(); }
  function analyzeTrack(){ var pts=[]; for(var i=0;i<detectionsPerFrame.length;i++){ var d=detectionsPerFrame[i]; if(d.box){ var x1=d.box[0],y1=d.box[1],x2=d.box[2],y2=d.box[3]; pts.push({t:d.time, x:(x1+x2)/2, y:(y1+y2)/2}); } else { pts.push({t:d.time, x:null, y:null}); } } var speeds=[]; for(var i=0;i<pts.length;i++){ if(i===0||pts[i-1].x==null||pts[i].x==null){ speeds.push(null); continue; } var dt=pts[i].t-pts[i-1].t || (1/getFps()); var distPx=Math.sqrt(Math.pow(pts[i].x-pts[i-1].x,2)+Math.pow(pts[i].y-pts[i-1].y,2)); var sp=(distPx/dt)/getScale(); speeds.push(sp); } try{ if(posChart) posChart.destroy(); var posCtx=document.getElementById('posChart').getContext('2d'); var labels=pts.map(function(p){ return (p.t||0).toFixed(2); }); var xs=pts.map(function(p){ return p.x!=null?(p.x/getScale()):null; }); var ys=pts.map(function(p){ return p.y!=null?(p.y/getScale()):null; }); posChart=new Chart(posCtx,{type:'line',data:{labels:labels,datasets:[{label:'X (단위)',data:xs,borderColor:'#4fd1c5',tension:0.2,spanGaps:true},{label:'Y (단위)',data:ys,borderColor:'#f97316',tension:0.2,spanGaps:true}]},options:{responsive:true,maintainAspectRatio:false}}); if(velChart) velChart.destroy(); var velCtx=document.getElementById('velChart').getContext('2d'); var speedData=speeds.map(function(s){ return s||0; }); velChart=new Chart(velCtx,{type:'line',data:{labels:labels,datasets:[{label:'Speed (단위/초)',data:speedData,borderColor:'#60a5fa',tension:0.2,spanGaps:true}]},options:{responsive:true,maintainAspectRatio:false}}); }catch(e){} }

  // Actions
  if(runDetectBtn){ runDetectBtn.addEventListener('click', function(){ runYOLO(); }); }
  if(playResultsBtn){ playResultsBtn.addEventListener('click', function(){ if(!extractedFrames.length) return; var fps=getFps(); var idx=0; if(playTimer) clearInterval(playTimer); playTimer=setInterval(function(){ idx++; if(idx>=extractedFrames.length) idx=0; currentFrameIndex=idx; showFrame(idx); }, 1000/fps); }); }
  if(exportCSVBtn){ exportCSVBtn.addEventListener('click', function(e){ e.preventDefault(); if(!detectionsPerFrame.length){ alert('분석 후 내보내기 하세요.'); return; } var rows=[['frame','time_s','x_px','y_px','x_unit','y_unit','speed_unit_s']]; for(var i=0;i<detectionsPerFrame.length;i++){ var d=detectionsPerFrame[i]; var xpx=null, ypx=null; if(d.box){ xpx=(d.box[0]+d.box[2])/2; ypx=(d.box[1]+d.box[3])/2; } var xu=(xpx!=null)?(xpx/getScale()).toFixed(4):''; var yu=(ypx!=null)?(ypx/getScale()).toFixed(4):''; rows.push([i,(d.time||0).toFixed(4),xpx||'',ypx||'',xu,yu,'']); } var csv=rows.map(function(r){ return r.join(','); }).join('
'); var blob=new Blob([csv],{type:'text/csv'}); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download='analysis.csv'; a.click(); URL.revokeObjectURL(url); }); }

  // Init
  resizeOverlay();
})();
