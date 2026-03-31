import { useState, useRef, useCallback, useEffect } from "react";
import * as THREE from "three";

const STAMP_DEFAULTS = { diameter: 55, depth: 1.5, baseHeight: 3, minFeature: 1.5, rejectFeature: 1.0 };
const STAGES = ["upload", "analyzing", "review", "bw-preview", "svg-preview", "3d-preview"];
const theme = {
  bg: "#0F0F0F", surface: "#1A1A1A", surfaceHover: "#222222", border: "#2A2A2A",
  borderActive: "#E8985A", accent: "#E8985A", text: "#E8E8E8", textMuted: "#888888",
  textDim: "#555555", success: "#5CB85C", warning: "#E8985A", danger: "#D9534F", white: "#FFFFFF",
};

// ─── Binary STL Writer ──────────────────────────────────────────────
function generateSTLBinary(geometry) {
  const pos = geometry.getAttribute("position");
  const triCount = pos.count / 3;
  const buf = new ArrayBuffer(80 + 4 + triCount * 50);
  const dv = new DataView(buf);
  let offset = 80;
  dv.setUint32(offset, triCount, true); offset += 4;
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const cb = new THREE.Vector3(), ab = new THREE.Vector3();
  for (let i = 0; i < triCount; i++) {
    vA.fromBufferAttribute(pos, i*3); vB.fromBufferAttribute(pos, i*3+1); vC.fromBufferAttribute(pos, i*3+2);
    cb.subVectors(vC, vB); ab.subVectors(vA, vB); cb.cross(ab).normalize();
    [cb, vA, vB, vC].forEach(v => { dv.setFloat32(offset,v.x,true); offset+=4; dv.setFloat32(offset,v.y,true); offset+=4; dv.setFloat32(offset,v.z,true); offset+=4; });
    dv.setUint16(offset, 0, true); offset += 2;
  }
  return new Blob([buf], { type: "application/octet-stream" });
}

// ─── SVG Path → Three.js Shapes (handles M/L/C/Z + holes) ──────────
function parseSVGPathToShapes(pathD, svgW, svgH, stampSize) {
  const sc = stampSize / Math.max(svgW, svgH);
  const ox = (stampSize - svgW * sc) / 2;
  const oy = (stampSize - svgH * sc) / 2;
  const tx = x => x * sc + ox;
  const ty = y => stampSize - (y * sc + oy);

  const tokens = pathD.match(/[a-zA-Z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return [];

  const subpaths = [];
  let cur = null, cx = 0, cy = 0, sx = 0, sy = 0, ti = 0;
  const n = () => { while (ti < tokens.length && /^[a-zA-Z]$/.test(tokens[ti])) ti++; return ti < tokens.length ? parseFloat(tokens[ti++]) : 0; };
  const hasNums = () => ti < tokens.length && /^[-+\d.]/.test(tokens[ti]);

  while (ti < tokens.length) {
    const c = tokens[ti];
    if (!/^[a-zA-Z]$/.test(c)) { ti++; continue; }
    ti++;
    switch (c) {
      case 'M': cx=n(); cy=n(); sx=cx; sy=cy; cur=[{t:'M',x:cx,y:cy}]; while(hasNums()){cx=n();cy=n();cur.push({t:'L',x:cx,y:cy});} break;
      case 'm': cx+=n(); cy+=n(); sx=cx; sy=cy; cur=[{t:'M',x:cx,y:cy}]; while(hasNums()){cx+=n();cy+=n();cur.push({t:'L',x:cx,y:cy});} break;
      case 'L': while(hasNums()){cx=n();cy=n();cur&&cur.push({t:'L',x:cx,y:cy});} break;
      case 'l': while(hasNums()){cx+=n();cy+=n();cur&&cur.push({t:'L',x:cx,y:cy});} break;
      case 'H': while(hasNums()){cx=n();cur&&cur.push({t:'L',x:cx,y:cy});} break;
      case 'h': while(hasNums()){cx+=n();cur&&cur.push({t:'L',x:cx,y:cy});} break;
      case 'V': while(hasNums()){cy=n();cur&&cur.push({t:'L',x:cx,y:cy});} break;
      case 'v': while(hasNums()){cy+=n();cur&&cur.push({t:'L',x:cx,y:cy});} break;
      case 'C': while(hasNums()){const x1=n(),y1=n(),x2=n(),y2=n();cx=n();cy=n();cur&&cur.push({t:'C',x1,y1,x2,y2,x:cx,y:cy});} break;
      case 'c': while(hasNums()){const x1=cx+n(),y1=cy+n(),x2=cx+n(),y2=cy+n();cx+=n();cy+=n();cur&&cur.push({t:'C',x1,y1,x2,y2,x:cx,y:cy});} break;
      case 'Z': case 'z': if(cur){cur.push({t:'Z'}); subpaths.push(cur); cur=null;} cx=sx;cy=sy; break;
    }
  }
  if (cur && cur.length > 1) subpaths.push(cur);

  // Calculate signed area to determine winding (outer vs hole)
  function signedArea(sp) {
    let a = 0, pts = sp.filter(s => s.x !== undefined).map(s => [s.x, s.y]);
    for (let j = 0; j < pts.length; j++) { const k = (j+1) % pts.length; a += pts[j][0]*pts[k][1] - pts[k][0]*pts[j][1]; }
    return a / 2;
  }

  function buildPath(sp, PathClass) {
    const p = new PathClass();
    for (const s of sp) {
      if (s.t === 'M') p.moveTo(tx(s.x), ty(s.y));
      else if (s.t === 'L') p.lineTo(tx(s.x), ty(s.y));
      else if (s.t === 'C') p.bezierCurveTo(tx(s.x1), ty(s.y1), tx(s.x2), ty(s.y2), tx(s.x), ty(s.y));
    }
    return p;
  }

  const shapes = [];
  let currentShape = null;

  for (const sp of subpaths) {
    const area = signedArea(sp);
    if (area > 0 || !currentShape) {
      currentShape = buildPath(sp, THREE.Shape);
      shapes.push(currentShape);
    } else {
      const hole = buildPath(sp, THREE.Path);
      currentShape.holes.push(hole);
    }
  }
  return shapes;
}


// ─── Main Component ──────────────────────────────────────────────────
export default function App() {
  const [stage, setStage] = useState("upload");
  const [image, setImage] = useState(null);
  const [imageBase64, setImageBase64] = useState(null);
  const [imageMediaType, setImageMediaType] = useState("image/jpeg");
  const [analysis, setAnalysis] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);
  const [bwCanvas, setBwCanvas] = useState(null);
  const [bwImageData, setBwImageData] = useState(null);
  const [bwDimensions, setBwDimensions] = useState(null);
  const [svgMarkup, setSvgMarkup] = useState(null);
  const [svgPathD, setSvgPathD] = useState(null);
  const [svgViewBox, setSvgViewBox] = useState(null);
  const [threshold, setThreshold] = useState(128);
  const [stampSize, setStampSize] = useState(STAMP_DEFAULTS.diameter);
  const [extrudeDepth, setExtrudeDepth] = useState(STAMP_DEFAULTS.depth);
  const [stlBlob, setStlBlob] = useState(null);
  const [includeBase, setIncludeBase] = useState(true);
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [potraceReady, setPotraceReady] = useState(false);

  const threeContainerRef = useRef(null);
  const threeCleanupRef = useRef(null);
  const fileInputRef = useRef(null);
  const potraceRef = useRef(null);

  // Init Potrace WASM
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mod = await import('esm-potrace-wasm');
        await mod.init();
        potraceRef.current = mod.potrace;
        if (!cancelled) setPotraceReady(true);
      } catch (err) { console.warn("Potrace WASM load failed:", err); }
    })();
    return () => { cancelled = true; };
  }, []);

  // File handling
  const handleFile = useCallback((file) => {
    if (!file?.type.startsWith("image/")) return;
    setImageMediaType(file.type || "image/jpeg");
    const reader = new FileReader();
    reader.onload = (e) => {
      setImage(e.target.result); setImageBase64(e.target.result.split(",")[1]);
      setStage("upload"); setAnalysis(null); setAnalysisError(null);
      setBwCanvas(null); setBwImageData(null); setSvgMarkup(null); setSvgPathD(null); setStlBlob(null);
    };
    reader.readAsDataURL(file);
  }, []);

  // AI Analysis
  const runAnalysis = useCallback(async () => {
    if (!imageBase64) return;
    setStage("analyzing"); setAnalysisError(null); setAnalysisProgress("Sending image to Claude...");
    const systemPrompt = `You are a cookie stamp design assistant for Cookie&me. Analyse reference images and decide how to convert them to 3D-printable cookie stamps.
Stamp diameter: ${stampSize}mm. Min feature: ${STAMP_DEFAULTS.minFeature}mm. Reject below ${STAMP_DEFAULTS.rejectFeature}mm.
Return ONLY valid JSON (no markdown, no backticks):
{"summary":"...","elements":[{"name":"...","action":"keep|simplify|merge|drop|enlarge|flag","reason":"...","printRisk":"none|low|medium|high","details":"..."}],"ambiguities":[{"element":"...","optionA":"...","optionB":"...","recommendation":"..."}],"processingInstructions":{"suggestedThreshold":128,"invertColors":false,"notes":"..."},"overallConfidence":"high|medium|low","confidenceNotes":"..."}
Principles: preserve logo recognition; raised areas press INTO dough (mirror image); thin lines/small text fail at this scale; gradients must become solid B&W; be specific about changes; note if text needs mirroring.`;

    try {
      setAnalysisProgress("Waiting for AI...");
      const res = await fetch("/api/analyze", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514", max_tokens: 2000, system: systemPrompt,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: imageMediaType, data: imageBase64 } },
            { type: "text", text: `Analyse this image for a ${stampSize}mm cookie stamp. Return ONLY JSON.` }
          ]}]
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || data.error || `API ${res.status}`);
      const text = data.content?.filter(b => b.type === "text").map(b => b.text).join("") || "";
      if (!text) throw new Error("Empty API response");
      const parsed = JSON.parse(text.replace(/```json\s*|```\s*/g, "").trim());
      setAnalysis(parsed);
      if (parsed.processingInstructions?.suggestedThreshold) setThreshold(parsed.processingInstructions.suggestedThreshold);
      setStage("review"); setAnalysisProgress("");
    } catch (err) { setAnalysisError(err.message); setStage("upload"); setAnalysisProgress(""); }
  }, [imageBase64, imageMediaType, stampSize]);

  // B&W Conversion
  const generateBW = useCallback(() => {
    if (!image) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const r = Math.min(500 / img.width, 500 / img.height, 1);
      const w = Math.round(img.width * r), h = Math.round(img.height * r);
      const canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0, w, h);
      const id = ctx.getImageData(0, 0, w, h), d = id.data;
      const inv = analysis?.processingInstructions?.invertColors || false;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
        let v = g < threshold ? 0 : 255; if (inv) v = 255 - v;
        d[i] = d[i+1] = d[i+2] = v; d[i+3] = 255;
      }
      ctx.putImageData(id, 0, 0);
      setBwCanvas(canvas.toDataURL()); setBwImageData(id); setBwDimensions({ w, h }); setStage("bw-preview");
    };
    img.src = image;
  }, [image, threshold, analysis]);

  // SVG Tracing with Potrace
  const generateSVG = useCallback(async () => {
    if (!bwImageData || !bwDimensions) return;
    try {
      if (!potraceRef.current) throw new Error("Potrace not loaded");
      const svg = await potraceRef.current(bwImageData, {
        turdsize: 2, turnpolicy: 4, alphamax: 1, opticurve: 1, opttolerance: 0.2, pathonly: false,
      });
      setSvgMarkup(svg);
      // Extract all path d attributes and combine
      const pathMatches = [...svg.matchAll(/\bd="([^"]+)"/g)];
      const allD = pathMatches.map(m => m[1]).join(" ");
      setSvgPathD(allD);
      const vbMatch = svg.match(/viewBox="([^"]+)"/);
      if (vbMatch) {
        const parts = vbMatch[1].split(/\s+/).map(Number);
        setSvgViewBox({ width: parts[2] || bwDimensions.w, height: parts[3] || bwDimensions.h });
      } else {
        setSvgViewBox({ width: bwDimensions.w, height: bwDimensions.h });
      }
      setStage("svg-preview");
    } catch (err) {
      console.error("Potrace error:", err);
      // Fallback: very basic rect-based trace
      const { w, h } = bwDimensions; const d = bwImageData.data; let pathStr = "";
      const step = 2;
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) {
        if (d[(y*w+x)*4] === 0) pathStr += `M${x},${y}h${step}v${step}h-${step}Z `;
      }
      const fallbackSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><path d="${pathStr}" fill="black"/></svg>`;
      setSvgMarkup(fallbackSvg); setSvgPathD(pathStr); setSvgViewBox({ width: w, height: h }); setStage("svg-preview");
    }
  }, [bwImageData, bwDimensions]);

  // 3D Preview & STL
  const generate3D = useCallback(() => {
    if (!svgPathD || !svgViewBox || !threeContainerRef.current) return;
    if (threeCleanupRef.current) { threeCleanupRef.current(); threeCleanupRef.current = null; }
    threeContainerRef.current.innerHTML = "";
    const container = threeContainerRef.current;
    const cw = container.clientWidth || 500, ch = 400;
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0x1a1a1a);
    const camera = new THREE.PerspectiveCamera(45, cw/ch, 0.1, 1000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(cw, ch); renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8); dir.position.set(stampSize, stampSize*2, stampSize); scene.add(dir);
    const group = new THREE.Group();

    if (includeBase) {
      const bg = new THREE.CylinderGeometry(stampSize/2, stampSize/2, STAMP_DEFAULTS.baseHeight, 64);
      const bm = new THREE.Mesh(bg, new THREE.MeshPhongMaterial({ color: 0xcccccc }));
      bm.position.set(stampSize/2, -STAMP_DEFAULTS.baseHeight/2, stampSize/2); group.add(bm);
    }

    const shapes = parseSVGPathToShapes(svgPathD, svgViewBox.width, svgViewBox.height, stampSize);
    const mat = new THREE.MeshPhongMaterial({ color: 0xe8985a });
    let count = 0;
    for (const shape of shapes) {
      try {
        const eg = new THREE.ExtrudeGeometry(shape, { depth: extrudeDepth, bevelEnabled: false, curveSegments: 12 });
        const m = new THREE.Mesh(eg, mat); m.rotation.x = -Math.PI/2; group.add(m); count++;
      } catch(e) {}
    }
    scene.add(group);

    // Generate STL
    const allPos = [], allNorm = [];
    group.updateMatrixWorld(true);
    group.traverse(child => {
      if (!child.isMesh) return;
      let g = child.geometry.clone(); g.applyMatrix4(child.matrixWorld);
      if (g.index) g = g.toNonIndexed(); g.computeVertexNormals();
      allPos.push(new Float32Array(g.getAttribute("position").array));
      allNorm.push(new Float32Array(g.getAttribute("normal").array));
    });
    if (allPos.length) {
      const tot = allPos.reduce((s,a) => s+a.length, 0);
      const pa = new Float32Array(tot), na = new Float32Array(tot); let o = 0;
      allPos.forEach((a,i) => { pa.set(a,o); na.set(allNorm[i],o); o+=a.length; });
      const mg = new THREE.BufferGeometry();
      mg.setAttribute("position", new THREE.BufferAttribute(pa,3));
      mg.setAttribute("normal", new THREE.BufferAttribute(na,3));
      setStlBlob(generateSTLBinary(mg));
    }

    let angle = 0, animId;
    const animate = () => {
      angle += 0.005; const dist = stampSize*1.4;
      camera.position.set(stampSize/2+Math.sin(angle)*dist, stampSize*0.6, stampSize/2+Math.cos(angle)*dist);
      camera.lookAt(stampSize/2, 0, stampSize/2); renderer.render(scene, camera);
      animId = requestAnimationFrame(animate);
    };
    animate();
    threeCleanupRef.current = () => { cancelAnimationFrame(animId); renderer.dispose(); };
  }, [svgPathD, svgViewBox, stampSize, extrudeDepth, includeBase]);

  useEffect(() => { if (stage === "3d-preview") { const t = setTimeout(generate3D, 150); return () => clearTimeout(t); } }, [stage, generate3D]);
  useEffect(() => () => { if (threeCleanupRef.current) threeCleanupRef.current(); }, []);

  const downloadSTL = useCallback(() => {
    if (!stlBlob) return;
    const u = URL.createObjectURL(stlBlob); const a = document.createElement("a");
    a.href = u; a.download = "cookie-stamp-face.stl"; a.click(); URL.revokeObjectURL(u);
  }, [stlBlob]);

  const stageLabels = ["Upload", "AI Analysis", "Review", "B&W", "SVG", "3D / Export"];
  const currentIdx = STAGES.indexOf(stage);
  const primaryBtn = { padding:"14px 24px", background:theme.accent, color:theme.bg, border:"none", borderRadius:8, fontSize:15, fontWeight:600, cursor:"pointer", flex:1 };
  const ghostBtn = { padding:"14px 24px", background:"transparent", color:theme.textMuted, border:`1px solid ${theme.border}`, borderRadius:8, fontSize:14, cursor:"pointer" };

  const resetAll = () => {
    setStage("upload"); setImage(null); setImageBase64(null); setAnalysis(null); setAnalysisError(null);
    setBwCanvas(null); setBwImageData(null); setSvgMarkup(null); setSvgPathD(null); setStlBlob(null);
    if (threeCleanupRef.current) { threeCleanupRef.current(); threeCleanupRef.current = null; }
  };

  return (
    <div style={{ minHeight:"100vh", background:theme.bg, color:theme.text, fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif" }}>
      {/* Header */}
      <div style={{ padding:"20px 24px", borderBottom:`1px solid ${theme.border}`, display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
        <div style={{ display:"flex", alignItems:"baseline", gap:10 }}>
          <span style={{ fontSize:20, fontWeight:700, letterSpacing:"-0.02em", color:theme.accent }}>Cookie&me</span>
          <span style={{ fontSize:14, color:theme.textMuted }}>Stamp Design Tool</span>
          {!potraceReady && <span style={{ fontSize:11, color:theme.warning, marginLeft:8 }}>Loading Potrace...</span>}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8, fontSize:12, color:theme.textMuted }}>
          <span>Stamp ø</span>
          <input type="number" value={stampSize} onChange={e => setStampSize(Number(e.target.value)||55)}
            style={{ width:52, padding:"3px 6px", background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:4, color:theme.text, fontSize:12, textAlign:"center" }} />
          <span>mm</span>
        </div>
      </div>

      {/* Progress */}
      <div style={{ padding:"12px 24px", borderBottom:`1px solid ${theme.border}`, display:"flex", gap:4, alignItems:"center", overflowX:"auto" }}>
        {stageLabels.map((label, i) => {
          const isActive = i === currentIdx || (stage === "analyzing" && i === 1);
          const isDone = i < currentIdx;
          return (<div key={label} style={{ display:"flex", alignItems:"center", gap:4 }}>
            <div style={{ padding:"4px 10px", borderRadius:12, fontSize:11, fontWeight:isActive?600:400, whiteSpace:"nowrap",
              background: isActive ? theme.accent : isDone ? theme.surfaceHover : "transparent",
              color: isActive ? theme.bg : isDone ? theme.text : theme.textDim }}>{isDone?"✓ ":""}{label}</div>
            {i < stageLabels.length-1 && <div style={{ width:16, height:1, background: isDone ? theme.accent : theme.border }} />}
          </div>);
        })}
      </div>

      <div style={{ padding:24, maxWidth:900, margin:"0 auto" }}>
        {/* UPLOAD */}
        {stage === "upload" && (<div>
          <div onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragOver(false); e.dataTransfer?.files?.[0] && handleFile(e.dataTransfer.files[0]); }}
            onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
            onClick={() => fileInputRef.current?.click()}
            style={{ border:`2px dashed ${dragOver?theme.accent:image?theme.borderActive:theme.border}`, borderRadius:12,
              padding:image?16:60, textAlign:"center", cursor:"pointer", background: dragOver?`${theme.accent}08`:theme.surface }}>
            {image ? (<div><img src={image} alt="Ref" style={{ maxWidth:"100%", maxHeight:300, borderRadius:8 }} />
              <p style={{ color:theme.textMuted, marginTop:12, fontSize:13 }}>Click or drop to replace</p></div>
            ) : (<div><div style={{ fontSize:40, marginBottom:12, opacity:0.4 }}>↓</div>
              <p style={{ fontSize:16, fontWeight:500, marginBottom:6 }}>Drop a reference image here</p>
              <p style={{ fontSize:13, color:theme.textMuted }}>Logo, photo, or design — any format, any colour complexity</p></div>)}
            <input ref={fileInputRef} type="file" accept="image/*" onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])} style={{ display:"none" }} />
          </div>
          {image && <button onClick={runAnalysis} style={{ ...primaryBtn, width:"100%", marginTop:16 }}>Analyse with AI →</button>}
          {analysisError && <div style={{ marginTop:16, padding:16, background:`${theme.danger}15`, border:`1px solid ${theme.danger}40`, borderRadius:8, fontSize:13, color:"#f0a0a0", lineHeight:1.6 }}>
            <strong style={{ color:theme.danger }}>Analysis failed:</strong> {analysisError}</div>}
        </div>)}

        {/* ANALYZING */}
        {stage === "analyzing" && (<div style={{ textAlign:"center", padding:60 }}>
          <div style={{ width:40, height:40, margin:"0 auto 20px", border:`3px solid ${theme.border}`, borderTopColor:theme.accent, borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          <p style={{ fontSize:15, fontWeight:500, marginBottom:8 }}>Analysing your image...</p>
          <p style={{ fontSize:13, color:theme.textMuted }}>{analysisProgress}</p>
        </div>)}

        {/* REVIEW */}
        {stage === "review" && analysis && (<div>
          <div style={{ display:"flex", gap:20, marginBottom:24, flexWrap:"wrap" }}>
            {image && <img src={image} alt="Ref" style={{ width:140, height:140, objectFit:"contain", borderRadius:8, border:`1px solid ${theme.border}`, background:theme.surface, flexShrink:0 }} />}
            <div style={{ flex:1, minWidth:200 }}>
              <h3 style={{ fontSize:16, fontWeight:600, marginBottom:8, marginTop:0 }}>AI Analysis Summary</h3>
              <p style={{ fontSize:14, lineHeight:1.6, color:theme.textMuted, margin:0 }}>{analysis.summary}</p>
              <div style={{ marginTop:10, display:"inline-flex", alignItems:"center", gap:6, padding:"4px 10px", borderRadius:6, fontSize:12,
                background: analysis.overallConfidence==="high"?`${theme.success}20`:analysis.overallConfidence==="medium"?`${theme.warning}20`:`${theme.danger}20`,
                color: analysis.overallConfidence==="high"?theme.success:analysis.overallConfidence==="medium"?theme.warning:theme.danger }}>
                Confidence: {analysis.overallConfidence}{analysis.confidenceNotes && ` — ${analysis.confidenceNotes}`}
              </div>
            </div>
          </div>
          <h4 style={{ fontSize:13, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em", color:theme.textMuted, marginBottom:12 }}>Design Decisions</h4>
          <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:20 }}>
            {analysis.elements?.map((el,i) => {
              const ac = {keep:theme.success,simplify:theme.warning,merge:theme.accent,drop:theme.danger,enlarge:"#6CA6D9",flag:theme.danger};
              const col = ac[el.action]||theme.textMuted;
              return (<div key={i} style={{ padding:"12px 16px", background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:8, borderLeft:`3px solid ${col}` }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
                  <span style={{ fontWeight:600, fontSize:14 }}>{el.name}</span>
                  <span style={{ fontSize:11, fontWeight:600, textTransform:"uppercase", padding:"2px 8px", borderRadius:4, color:col, background:`${col}18` }}>{el.action}</span>
                </div>
                <p style={{ fontSize:13, color:theme.textMuted, margin:0, lineHeight:1.5 }}>{el.reason}</p>
                {el.details && <p style={{ fontSize:12, color:theme.textDim, margin:"4px 0 0", fontStyle:"italic" }}>{el.details}</p>}
                {el.printRisk && el.printRisk!=="none" && <span style={{ display:"inline-block", marginTop:6, fontSize:11, padding:"2px 6px", borderRadius:3,
                  background:el.printRisk==="high"?`${theme.danger}20`:`${theme.warning}20`, color:el.printRisk==="high"?theme.danger:theme.warning }}>Print risk: {el.printRisk}</span>}
              </div>);
            })}
          </div>
          {analysis.ambiguities?.length > 0 && <div style={{ marginBottom:20 }}>
            <h4 style={{ fontSize:13, fontWeight:600, textTransform:"uppercase", letterSpacing:"0.05em", color:theme.warning, marginBottom:12 }}>Needs Your Input</h4>
            {analysis.ambiguities.map((amb,i) => (<div key={i} style={{ padding:16, background:`${theme.warning}08`, border:`1px solid ${theme.warning}30`, borderRadius:8, marginBottom:8 }}>
              <p style={{ fontWeight:600, fontSize:14, margin:"0 0 8px" }}>{amb.element}</p>
              <div style={{ fontSize:13, lineHeight:1.6, color:theme.textMuted }}>
                <div style={{ marginBottom:4 }}><strong>Option A:</strong> {amb.optionA}</div>
                <div style={{ marginBottom:4 }}><strong>Option B:</strong> {amb.optionB}</div>
                <div style={{ color:theme.accent }}><strong>Rec:</strong> {amb.recommendation}</div>
              </div>
            </div>))}
          </div>}
          {analysis.processingInstructions?.notes && <div style={{ padding:12, background:theme.surface, borderRadius:8, border:`1px solid ${theme.border}`, fontSize:13, color:theme.textMuted, marginBottom:20 }}>
            <strong>Processing notes:</strong> {analysis.processingInstructions.notes}</div>}
          <div style={{ display:"flex", gap:12 }}>
            <button onClick={generateBW} style={primaryBtn}>Approve & Generate B&W →</button>
            <button onClick={() => { setStage("upload"); setAnalysis(null); }} style={ghostBtn}>Re-analyse</button>
          </div>
        </div>)}

        {/* B&W */}
        {stage === "bw-preview" && (<div>
          <h3 style={{ fontSize:16, fontWeight:600, marginBottom:16, marginTop:0 }}>Black & White Preview</h3>
          <div style={{ display:"flex", gap:20, alignItems:"flex-start", flexWrap:"wrap" }}>
            <div style={{ flex:"1 1 300px", background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:8, padding:16, textAlign:"center" }}>
              {bwCanvas && <img src={bwCanvas} alt="B&W" style={{ maxWidth:"100%", maxHeight:300, borderRadius:4 }} />}
            </div>
            <div style={{ flex:"0 0 200px" }}>
              <label style={{ fontSize:12, color:theme.textMuted, display:"block", marginBottom:6 }}>Threshold: {threshold}</label>
              <input type="range" min="1" max="255" value={threshold} onChange={e => setThreshold(Number(e.target.value))} style={{ width:"100%", accentColor:theme.accent }} />
              <p style={{ fontSize:11, color:theme.textDim, marginTop:4, lineHeight:1.4 }}>Lower = more detail. Higher = simpler.</p>
              <button onClick={generateBW} style={{ marginTop:12, width:"100%", padding:"8px 12px", background:theme.surfaceHover, color:theme.text, border:`1px solid ${theme.border}`, borderRadius:6, fontSize:13, cursor:"pointer" }}>Regenerate</button>
            </div>
          </div>
          <div style={{ display:"flex", gap:12, marginTop:20 }}>
            <button onClick={generateSVG} style={primaryBtn}>{potraceReady?"Trace with Potrace →":"Trace to SVG →"}</button>
            <button onClick={() => setStage("review")} style={ghostBtn}>← Back</button>
          </div>
        </div>)}

        {/* SVG */}
        {stage === "svg-preview" && (<div>
          <h3 style={{ fontSize:16, fontWeight:600, marginBottom:16, marginTop:0 }}>SVG Trace Preview</h3>
          <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:8, padding:16, textAlign:"center" }}>
            {svgMarkup ? (
              <div style={{ display:"inline-block", background:"#fff", borderRadius:4, padding:8 }}
                dangerouslySetInnerHTML={{ __html: svgMarkup.replace(/<svg/, `<svg style="max-width:400px;max-height:400px;width:100%;height:auto"`) }} />
            ) : <p style={{ color:theme.textMuted }}>No SVG generated</p>}
            <p style={{ fontSize:12, color:theme.textMuted, marginTop:8 }}>{potraceReady?"Traced with Potrace — smooth Bezier curves":"Basic trace"}</p>
          </div>
          <div style={{ display:"flex", gap:12, marginTop:20 }}>
            <button onClick={() => setStage("3d-preview")} style={primaryBtn}>Generate 3D Preview →</button>
            <button onClick={() => setStage("bw-preview")} style={ghostBtn}>← Back</button>
          </div>
        </div>)}

        {/* 3D */}
        {stage === "3d-preview" && (<div>
          <h3 style={{ fontSize:16, fontWeight:600, marginBottom:16, marginTop:0 }}>3D Stamp Preview</h3>
          <div style={{ background:theme.surface, border:`1px solid ${theme.border}`, borderRadius:8, overflow:"hidden", marginBottom:16 }}>
            <div ref={threeContainerRef} style={{ width:"100%", height:400 }} />
          </div>
          <div style={{ display:"flex", gap:16, marginBottom:20, flexWrap:"wrap", alignItems:"center" }}>
            <div>
              <label style={{ fontSize:12, color:theme.textMuted, display:"block", marginBottom:4 }}>Extrusion: {extrudeDepth}mm</label>
              <input type="range" min="0.5" max="4" step="0.1" value={extrudeDepth} onChange={e => setExtrudeDepth(Number(e.target.value))} style={{ width:180, accentColor:theme.accent }} />
            </div>
            <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:13, color:theme.textMuted, cursor:"pointer" }}>
              <input type="checkbox" checked={includeBase} onChange={e => setIncludeBase(e.target.checked)} />
              Include base plate ({STAMP_DEFAULTS.baseHeight}mm)
            </label>
            <button onClick={generate3D} style={{ padding:"6px 14px", background:theme.surfaceHover, color:theme.text, border:`1px solid ${theme.border}`, borderRadius:6, fontSize:13, cursor:"pointer" }}>Regenerate 3D</button>
          </div>
          <div style={{ display:"flex", gap:12 }}>
            <button onClick={downloadSTL} disabled={!stlBlob} style={{ ...primaryBtn, background:stlBlob?theme.success:theme.surfaceHover, color:stlBlob?theme.white:theme.textDim, cursor:stlBlob?"pointer":"default" }}>↓ Download STL</button>
            <button onClick={() => setStage("svg-preview")} style={ghostBtn}>← Back</button>
          </div>
          <div style={{ marginTop:16, padding:12, background:theme.surface, borderRadius:8, border:`1px solid ${theme.border}`, fontSize:12, color:theme.textDim, lineHeight:1.5 }}>
            <strong style={{ color:theme.textMuted }}>Note:</strong> Stamp face {includeBase?"with base plate":"only (no base)"}.
            {!includeBase && " Combine with handle in TinkerCAD."} Design is not mirrored — mirror in slicer if text is present.
          </div>
        </div>)}

        {stage !== "upload" && stage !== "analyzing" && (
          <div style={{ marginTop:32, textAlign:"center" }}>
            <button onClick={resetAll} style={{ padding:"8px 20px", background:"transparent", color:theme.textDim, border:`1px solid ${theme.border}`, borderRadius:6, fontSize:12, cursor:"pointer" }}>Start over with new image</button>
          </div>
        )}
      </div>
    </div>
  );
}
