import { useState, useRef, useCallback, useEffect } from "react";
import * as THREE from "three";

// ─── Constants ───────────────────────────────────────────────────────
const STAMP_DEFAULTS = {
  diameter: 55,
  depth: 1.5,
  baseHeight: 3,
  minFeature: 1.5,
  rejectFeature: 1.0,
};

const STAGES = [
  "upload",
  "analyzing",
  "review",
  "bw-preview",
  "svg-preview",
  "3d-preview",
];

const theme = {
  bg: "#0F0F0F",
  surface: "#1A1A1A",
  surfaceHover: "#222222",
  border: "#2A2A2A",
  borderActive: "#E8985A",
  accent: "#E8985A",
  accentDim: "#B8734A",
  text: "#E8E8E8",
  textMuted: "#888888",
  textDim: "#555555",
  success: "#5CB85C",
  warning: "#E8985A",
  danger: "#D9534F",
  white: "#FFFFFF",
};

// ─── Utility: Binary STL Writer ──────────────────────────────────────
function generateSTLBinary(geometry) {
  const pos = geometry.getAttribute("position");
  const triCount = pos.count / 3;
  const bufLen = 80 + 4 + triCount * 50;
  const buf = new ArrayBuffer(bufLen);
  const dv = new DataView(buf);
  // 80 byte header - leave as zeros
  let offset = 80;
  dv.setUint32(offset, triCount, true);
  offset += 4;
  const vA = new THREE.Vector3(),
    vB = new THREE.Vector3(),
    vC = new THREE.Vector3();
  const cb = new THREE.Vector3(),
    ab = new THREE.Vector3();
  for (let i = 0; i < triCount; i++) {
    const base = i * 3;
    vA.fromBufferAttribute(pos, base);
    vB.fromBufferAttribute(pos, base + 1);
    vC.fromBufferAttribute(pos, base + 2);
    cb.subVectors(vC, vB);
    ab.subVectors(vA, vB);
    cb.cross(ab).normalize();
    dv.setFloat32(offset, cb.x, true); offset += 4;
    dv.setFloat32(offset, cb.y, true); offset += 4;
    dv.setFloat32(offset, cb.z, true); offset += 4;
    for (const v of [vA, vB, vC]) {
      dv.setFloat32(offset, v.x, true); offset += 4;
      dv.setFloat32(offset, v.y, true); offset += 4;
      dv.setFloat32(offset, v.z, true); offset += 4;
    }
    dv.setUint16(offset, 0, true);
    offset += 2;
  }
  return new Blob([buf], { type: "application/octet-stream" });
}

// ─── Utility: Marching Squares Contour Tracer ────────────────────────
function traceContours(imageData, width, height, threshold = 128) {
  // Build binary grid: 1 = dark (ink), 0 = light (background)
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    grid[i] = imageData[i * 4] < threshold ? 1 : 0;
  }

  const visited = new Set();
  const contours = [];

  function getCell(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return grid[y * width + x];
  }

  // Returns 4-bit case index for the 2x2 cell starting at (x,y)
  function marchCase(x, y) {
    return (
      (getCell(x, y) << 3) |
      (getCell(x + 1, y) << 2) |
      (getCell(x + 1, y + 1) << 1) |
      getCell(x, y + 1)
    );
  }

  // Direction vectors: 0=up, 1=right, 2=down, 3=left
  const dx = [0, 1, 0, -1];
  const dy = [-1, 0, 1, 0];

  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const c = marchCase(x, y);
      if (c === 0 || c === 15) continue;
      const key = `${x},${y}`;
      if (visited.has(key)) continue;

      const contour = [];
      let cx = x,
        cy = y;
      let prevDir = -1;
      let steps = 0;
      const maxSteps = width * height * 2;

      while (steps < maxSteps) {
        const ck = `${cx},${cy}`;
        if (steps > 0 && cx === x && cy === y) break;
        visited.add(ck);
        const cs = marchCase(cx, cy);
        if (cs === 0 || cs === 15) break;

        let ex = cx + 0.5,
          ey = cy + 0.5;
        let nextDir;

        switch (cs) {
          case 1:  ex = cx; ey = cy + 0.5; nextDir = 3; break;
          case 2:  ex = cx + 0.5; ey = cy + 1; nextDir = 2; break;
          case 3:  ex = cx; ey = cy + 0.5; nextDir = 3; break;
          case 4:  ex = cx + 1; ey = cy + 0.5; nextDir = 1; break;
          case 5:  nextDir = prevDir === 0 ? 1 : 3; ex = nextDir === 1 ? cx + 1 : cx; ey = cy + 0.5; break;
          case 6:  ex = cx + 0.5; ey = cy + 1; nextDir = 2; break;
          case 7:  ex = cx; ey = cy + 0.5; nextDir = 3; break;
          case 8:  ex = cx + 0.5; ey = cy; nextDir = 0; break;
          case 9:  ex = cx + 0.5; ey = cy; nextDir = 0; break;
          case 10: nextDir = prevDir === 1 ? 0 : 2; ey = nextDir === 0 ? cy : cy + 1; ex = cx + 0.5; break;
          case 11: ex = cx + 0.5; ey = cy; nextDir = 0; break;
          case 12: ex = cx + 1; ey = cy + 0.5; nextDir = 1; break;
          case 13: ex = cx + 1; ey = cy + 0.5; nextDir = 1; break;
          case 14: ex = cx + 0.5; ey = cy + 1; nextDir = 2; break;
          default: nextDir = 0;
        }

        contour.push([ex, ey]);
        prevDir = nextDir;
        cx += dx[nextDir];
        cy += dy[nextDir];
        steps++;

        // Bounds check
        if (cx < -1 || cx >= width || cy < -1 || cy >= height) break;
      }

      if (contour.length > 8) {
        contours.push(contour);
      }
    }
  }

  return contours;
}

function simplifyPath(points, tolerance = 1.5) {
  if (points.length < 3) return points;
  function perpDist(pt, a, b) {
    const ddx = b[0] - a[0],
      ddy = b[1] - a[1];
    const len = Math.sqrt(ddx * ddx + ddy * ddy);
    if (len === 0)
      return Math.sqrt((pt[0] - a[0]) ** 2 + (pt[1] - a[1]) ** 2);
    return (
      Math.abs(ddy * pt[0] - ddx * pt[1] + b[0] * a[1] - b[1] * a[0]) / len
    );
  }
  function rdp(pts, start, end) {
    if (end - start < 2) return [pts[start], pts[end]];
    let maxDist = 0,
      maxIdx = start;
    for (let i = start + 1; i < end; i++) {
      const d = perpDist(pts[i], pts[start], pts[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance) {
      const left = rdp(pts, start, maxIdx);
      const right = rdp(pts, maxIdx, end);
      return [...left.slice(0, -1), ...right];
    }
    return [pts[start], pts[end]];
  }
  return rdp(points, 0, points.length - 1);
}

function contoursToSVGPath(contours, width, height, stampSize) {
  const scale = stampSize / Math.max(width, height);
  const offsetX = (stampSize - width * scale) / 2;
  const offsetY = (stampSize - height * scale) / 2;
  let d = "";
  for (const contour of contours) {
    const simplified = simplifyPath(contour, 1.0);
    if (simplified.length < 3) continue;
    const first = simplified[0];
    d += `M ${(first[0] * scale + offsetX).toFixed(2)} ${(first[1] * scale + offsetY).toFixed(2)} `;
    for (let i = 1; i < simplified.length; i++) {
      d += `L ${(simplified[i][0] * scale + offsetX).toFixed(2)} ${(simplified[i][1] * scale + offsetY).toFixed(2)} `;
    }
    d += "Z ";
  }
  return d;
}

function pathToShapes(contours, width, height, stampSize) {
  const scale = stampSize / Math.max(width, height);
  const offsetX = (stampSize - width * scale) / 2;
  const offsetY = (stampSize - height * scale) / 2;
  const shapes = [];

  for (const contour of contours) {
    const simplified = simplifyPath(contour, 1.0);
    if (simplified.length < 3) continue;
    const shape = new THREE.Shape();
    const first = simplified[0];
    shape.moveTo(
      first[0] * scale + offsetX,
      stampSize - (first[1] * scale + offsetY)
    );
    for (let i = 1; i < simplified.length; i++) {
      shape.lineTo(
        simplified[i][0] * scale + offsetX,
        stampSize - (simplified[i][1] * scale + offsetY)
      );
    }
    shape.closePath();
    shapes.push(shape);
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
  const [svgPath, setSvgPath] = useState(null);
  const [svgContours, setSvgContours] = useState(null);
  const [threshold, setThreshold] = useState(128);
  const [stampSize, setStampSize] = useState(STAMP_DEFAULTS.diameter);
  const [extrudeDepth, setExtrudeDepth] = useState(STAMP_DEFAULTS.depth);
  const [stlBlob, setStlBlob] = useState(null);
  const [includeBase, setIncludeBase] = useState(true);
  const [analysisProgress, setAnalysisProgress] = useState("");
  const [dragOver, setDragOver] = useState(false);

  const threeContainerRef = useRef(null);
  const threeCleanupRef = useRef(null);
  const fileInputRef = useRef(null);

  // ─── File handling ───────────────────────────────────────────────
  const handleFile = useCallback((file) => {
    if (!file || !file.type.startsWith("image/")) return;

    const mt = file.type || "image/jpeg";
    setImageMediaType(mt);

    const reader = new FileReader();
    reader.onload = (e) => {
      const dataUrl = e.target.result;
      setImage(dataUrl);
      setImageBase64(dataUrl.split(",")[1]);
      // Reset pipeline
      setStage("upload");
      setAnalysis(null);
      setAnalysisError(null);
      setBwCanvas(null);
      setBwImageData(null);
      setSvgPath(null);
      setSvgContours(null);
      setStlBlob(null);
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    },
    [handleFile]
  );

  // ─── AI Analysis via Netlify Function ────────────────────────────
  const runAnalysis = useCallback(async () => {
    if (!imageBase64) return;
    setStage("analyzing");
    setAnalysisError(null);
    setAnalysisProgress("Sending image to Claude for analysis...");

    const systemPrompt = `You are a cookie stamp design assistant for a custom cookie business called Cookie&me. You analyse reference images (logos, photos, designs) and make decisions about how to convert them into single-layer relief cookie stamps that will be 3D printed.

The stamp will be ${stampSize}mm in diameter. Minimum printable feature size is ${STAMP_DEFAULTS.minFeature}mm. Features below ${STAMP_DEFAULTS.rejectFeature}mm should be rejected.

Analyse the image and return ONLY valid JSON (no markdown, no backticks, no preamble) with this exact structure:
{
  "summary": "2-3 sentence overview of the image and overall approach",
  "elements": [
    {
      "name": "element name",
      "action": "keep|simplify|merge|drop|enlarge|flag",
      "reason": "why this decision was made",
      "printRisk": "none|low|medium|high",
      "details": "specific notes about this element"
    }
  ],
  "ambiguities": [
    {
      "element": "element name",
      "optionA": "first option description",
      "optionB": "second option description",
      "recommendation": "which option and why"
    }
  ],
  "processingInstructions": {
    "suggestedThreshold": 128,
    "invertColors": false,
    "notes": "any special processing notes"
  },
  "overallConfidence": "high|medium|low",
  "confidenceNotes": "explanation of confidence level"
}

Key principles:
- Preserve logo recognition above all else
- Raised areas in the stamp press INTO fondant/cookie dough, so the design will appear as an impression (mirror image)
- Thin lines, small text, and fine details often fail in 3D printing at this scale
- Gradients cannot be represented — everything must be solid black or white
- Internal details of shapes may fill in during printing if too small
- Be specific about what you'd change and why
- If text is present, note that it will need to be mirrored for the stamp`;

    const requestBody = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 2000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: imageMediaType,
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: `Analyse this image for conversion to a ${stampSize}mm cookie stamp. Return ONLY the JSON structure specified — no other text, no markdown fences.`,
            },
          ],
        },
      ],
    };

    try {
      setAnalysisProgress("Waiting for AI response...");

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      const data = await response.json();

      if (!response.ok) {
        const errMsg =
          data.error?.message || data.error || `API returned ${response.status}`;
        throw new Error(errMsg);
      }

      // Extract text from content blocks
      const text =
        data.content
          ?.filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("") || "";

      if (!text) {
        throw new Error("No text content in API response");
      }

      // Clean and parse JSON
      const clean = text.replace(/```json\s*|```\s*/g, "").trim();
      let parsed;
      try {
        parsed = JSON.parse(clean);
      } catch (parseErr) {
        throw new Error(
          `Failed to parse AI response as JSON: ${parseErr.message}. First 200 chars: ${clean.slice(0, 200)}`
        );
      }

      setAnalysis(parsed);
      if (parsed.processingInstructions?.suggestedThreshold) {
        setThreshold(parsed.processingInstructions.suggestedThreshold);
      }
      setStage("review");
      setAnalysisProgress("");
    } catch (err) {
      console.error("Analysis error:", err);
      setAnalysisError(err.message);
      setStage("upload");
      setAnalysisProgress("");
    }
  }, [imageBase64, imageMediaType, stampSize]);

  // ─── B&W Conversion ──────────────────────────────────────────────
  const generateBW = useCallback(() => {
    if (!image) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      // Scale down for tracing performance, keep aspect ratio
      const maxDim = 400;
      const ratio = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const w = Math.round(img.width * ratio);
      const h = Math.round(img.height * ratio);

      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, w, h);
      const imgData = ctx.getImageData(0, 0, w, h);
      const data = imgData.data;

      const invert =
        analysis?.processingInstructions?.invertColors || false;

      for (let i = 0; i < data.length; i += 4) {
        const gray =
          0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        let val = gray < threshold ? 0 : 255;
        if (invert) val = 255 - val;
        data[i] = data[i + 1] = data[i + 2] = val;
        data[i + 3] = 255;
      }

      ctx.putImageData(imgData, 0, 0);
      setBwCanvas(canvas.toDataURL());
      setBwImageData(imgData);
      setBwDimensions({ w, h });
      setStage("bw-preview");
    };
    img.src = image;
  }, [image, threshold, analysis]);

  // ─── SVG Tracing ─────────────────────────────────────────────────
  const generateSVG = useCallback(() => {
    if (!bwImageData || !bwDimensions) return;
    const contours = traceContours(
      bwImageData.data,
      bwDimensions.w,
      bwDimensions.h,
      threshold
    );
    const pathD = contoursToSVGPath(
      contours,
      bwDimensions.w,
      bwDimensions.h,
      stampSize
    );
    setSvgPath(pathD);
    setSvgContours(contours);
    setStage("svg-preview");
  }, [bwImageData, bwDimensions, threshold, stampSize]);

  // ─── 3D Preview & STL ────────────────────────────────────────────
  const generate3D = useCallback(() => {
    if (!svgContours || !bwDimensions || !threeContainerRef.current) return;

    // Clean up previous
    if (threeCleanupRef.current) {
      threeCleanupRef.current();
      threeCleanupRef.current = null;
    }
    threeContainerRef.current.innerHTML = "";

    const container = threeContainerRef.current;
    const cw = container.clientWidth || 500;
    const ch = 400;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a1a1a);

    const camera = new THREE.PerspectiveCamera(45, cw / ch, 0.1, 1000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(cw, ch);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(stampSize, stampSize * 2, stampSize);
    scene.add(dir);

    const group = new THREE.Group();

    // Base plate
    if (includeBase) {
      const baseGeo = new THREE.CylinderGeometry(
        stampSize / 2,
        stampSize / 2,
        STAMP_DEFAULTS.baseHeight,
        64
      );
      const baseMat = new THREE.MeshPhongMaterial({ color: 0xcccccc });
      const baseMesh = new THREE.Mesh(baseGeo, baseMat);
      baseMesh.position.set(
        stampSize / 2,
        -STAMP_DEFAULTS.baseHeight / 2,
        stampSize / 2
      );
      group.add(baseMesh);
    }

    // Extruded design shapes
    const shapes = pathToShapes(
      svgContours,
      bwDimensions.w,
      bwDimensions.h,
      stampSize
    );
    const designMat = new THREE.MeshPhongMaterial({ color: 0xe8985a });

    let shapeCount = 0;
    for (const shape of shapes) {
      try {
        const extGeo = new THREE.ExtrudeGeometry(shape, {
          depth: extrudeDepth,
          bevelEnabled: false,
        });
        const mesh = new THREE.Mesh(extGeo, designMat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.y = 0;
        group.add(mesh);
        shapeCount++;
      } catch (e) {
        // Skip degenerate shapes
      }
    }
    console.log(`Extruded ${shapeCount} shapes from ${shapes.length} total`);

    scene.add(group);

    // Generate STL from all meshes
    const allPositions = [];
    const allNormals = [];
    group.updateMatrixWorld(true);

    group.traverse((child) => {
      if (child.isMesh) {
        let geo = child.geometry.clone();
        geo.applyMatrix4(child.matrixWorld);
        if (geo.index) geo = geo.toNonIndexed();
        geo.computeVertexNormals();
        allPositions.push(new Float32Array(geo.getAttribute("position").array));
        allNormals.push(new Float32Array(geo.getAttribute("normal").array));
      }
    });

    if (allPositions.length > 0) {
      const totalLen = allPositions.reduce((s, a) => s + a.length, 0);
      const posArr = new Float32Array(totalLen);
      const normArr = new Float32Array(totalLen);
      let off = 0;
      for (let i = 0; i < allPositions.length; i++) {
        posArr.set(allPositions[i], off);
        normArr.set(allNormals[i], off);
        off += allPositions[i].length;
      }
      const mergedGeo = new THREE.BufferGeometry();
      mergedGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(posArr, 3)
      );
      mergedGeo.setAttribute("normal", new THREE.BufferAttribute(normArr, 3));
      setStlBlob(generateSTLBinary(mergedGeo));
    }

    // Animation loop
    let angle = 0;
    let animId;
    const animate = () => {
      angle += 0.005;
      const dist = stampSize * 1.4;
      camera.position.set(
        stampSize / 2 + Math.sin(angle) * dist,
        stampSize * 0.6,
        stampSize / 2 + Math.cos(angle) * dist
      );
      camera.lookAt(stampSize / 2, 0, stampSize / 2);
      renderer.render(scene, camera);
      animId = requestAnimationFrame(animate);
    };
    animate();

    threeCleanupRef.current = () => {
      cancelAnimationFrame(animId);
      renderer.dispose();
    };
  }, [svgContours, bwDimensions, stampSize, extrudeDepth, includeBase]);

  // Trigger 3D generation when entering that stage
  useEffect(() => {
    if (stage === "3d-preview") {
      const timer = setTimeout(generate3D, 150);
      return () => clearTimeout(timer);
    }
  }, [stage, generate3D]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (threeCleanupRef.current) threeCleanupRef.current();
    };
  }, []);

  const downloadSTL = useCallback(() => {
    if (!stlBlob) return;
    const url = URL.createObjectURL(stlBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "cookie-stamp-face.stl";
    a.click();
    URL.revokeObjectURL(url);
  }, [stlBlob]);

  // ─── Progress bar logic ──────────────────────────────────────────
  const stageLabels = [
    "Upload",
    "AI Analysis",
    "Review",
    "B&W",
    "SVG",
    "3D / Export",
  ];
  const currentIdx = STAGES.indexOf(stage);

  // ─── Shared button styles ────────────────────────────────────────
  const primaryBtn = {
    padding: "14px 24px",
    background: theme.accent,
    color: theme.bg,
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 0.15s",
    flex: 1,
  };
  const ghostBtn = {
    padding: "14px 24px",
    background: "transparent",
    color: theme.textMuted,
    border: `1px solid ${theme.border}`,
    borderRadius: 8,
    fontSize: 14,
    cursor: "pointer",
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: theme.bg,
        color: theme.text,
        fontFamily: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
      }}
    >
      {/* ─── HEADER ─────────────────────────────────────────────── */}
      <div
        style={{
          padding: "20px 24px",
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              color: theme.accent,
            }}
          >
            Cookie&me
          </span>
          <span style={{ fontSize: 14, color: theme.textMuted }}>
            Stamp Design Tool
          </span>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12,
            color: theme.textMuted,
          }}
        >
          <span>Stamp ø</span>
          <input
            type="number"
            value={stampSize}
            onChange={(e) => setStampSize(Number(e.target.value) || 55)}
            style={{
              width: 52,
              padding: "3px 6px",
              background: theme.surface,
              border: `1px solid ${theme.border}`,
              borderRadius: 4,
              color: theme.text,
              fontSize: 12,
              textAlign: "center",
            }}
          />
          <span>mm</span>
        </div>
      </div>

      {/* ─── STAGE PROGRESS ─────────────────────────────────────── */}
      <div
        style={{
          padding: "12px 24px",
          borderBottom: `1px solid ${theme.border}`,
          display: "flex",
          gap: 4,
          alignItems: "center",
          overflowX: "auto",
        }}
      >
        {stageLabels.map((label, i) => {
          const isActive =
            i === currentIdx || (stage === "analyzing" && i === 1);
          const isDone = i < currentIdx;
          return (
            <div
              key={label}
              style={{ display: "flex", alignItems: "center", gap: 4 }}
            >
              <div
                style={{
                  padding: "4px 10px",
                  borderRadius: 12,
                  fontSize: 11,
                  fontWeight: isActive ? 600 : 400,
                  whiteSpace: "nowrap",
                  background: isActive
                    ? theme.accent
                    : isDone
                      ? theme.surfaceHover
                      : "transparent",
                  color: isActive
                    ? theme.bg
                    : isDone
                      ? theme.text
                      : theme.textDim,
                  transition: "all 0.2s ease",
                }}
              >
                {isDone ? "✓ " : ""}
                {label}
              </div>
              {i < stageLabels.length - 1 && (
                <div
                  style={{
                    width: 16,
                    height: 1,
                    background: isDone ? theme.accent : theme.border,
                  }}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* ─── MAIN CONTENT ───────────────────────────────────────── */}
      <div style={{ padding: 24, maxWidth: 900, margin: "0 auto" }}>
        {/* ════════ UPLOAD ════════ */}
        {stage === "upload" && (
          <div>
            <div
              onDrop={handleDrop}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `2px dashed ${dragOver ? theme.accent : image ? theme.borderActive : theme.border}`,
                borderRadius: 12,
                padding: image ? 16 : 60,
                textAlign: "center",
                cursor: "pointer",
                transition: "all 0.2s ease",
                background: dragOver
                  ? `${theme.accent}08`
                  : theme.surface,
              }}
            >
              {image ? (
                <div>
                  <img
                    src={image}
                    alt="Reference"
                    style={{
                      maxWidth: "100%",
                      maxHeight: 300,
                      borderRadius: 8,
                    }}
                  />
                  <p
                    style={{
                      color: theme.textMuted,
                      marginTop: 12,
                      fontSize: 13,
                    }}
                  >
                    Click or drop to replace
                  </p>
                </div>
              ) : (
                <div>
                  <div style={{ fontSize: 40, marginBottom: 12, opacity: 0.4 }}>
                    ↓
                  </div>
                  <p
                    style={{
                      fontSize: 16,
                      fontWeight: 500,
                      marginBottom: 6,
                    }}
                  >
                    Drop a reference image here
                  </p>
                  <p style={{ fontSize: 13, color: theme.textMuted }}>
                    Logo, photo, or design — any format, any colour complexity
                  </p>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={(e) =>
                  e.target.files?.[0] && handleFile(e.target.files[0])
                }
                style={{ display: "none" }}
              />
            </div>

            {image && (
              <button
                onClick={runAnalysis}
                style={{ ...primaryBtn, width: "100%", marginTop: 16 }}
              >
                Analyse with AI →
              </button>
            )}

            {analysisError && (
              <div
                style={{
                  marginTop: 16,
                  padding: 16,
                  background: `${theme.danger}15`,
                  border: `1px solid ${theme.danger}40`,
                  borderRadius: 8,
                  fontSize: 13,
                  color: "#f0a0a0",
                  lineHeight: 1.6,
                }}
              >
                <strong style={{ color: theme.danger }}>
                  Analysis failed:
                </strong>{" "}
                {analysisError}
              </div>
            )}
          </div>
        )}

        {/* ════════ ANALYZING ════════ */}
        {stage === "analyzing" && (
          <div style={{ textAlign: "center", padding: 60 }}>
            <div
              style={{
                width: 40,
                height: 40,
                margin: "0 auto 20px",
                border: `3px solid ${theme.border}`,
                borderTopColor: theme.accent,
                borderRadius: "50%",
                animation: "spin 0.8s linear infinite",
              }}
            />
            <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
            <p style={{ fontSize: 15, fontWeight: 500, marginBottom: 8 }}>
              Analysing your image...
            </p>
            <p style={{ fontSize: 13, color: theme.textMuted }}>
              {analysisProgress}
            </p>
          </div>
        )}

        {/* ════════ REVIEW ════════ */}
        {stage === "review" && analysis && (
          <div>
            {/* Summary row */}
            <div
              style={{
                display: "flex",
                gap: 20,
                marginBottom: 24,
                flexWrap: "wrap",
              }}
            >
              {image && (
                <img
                  src={image}
                  alt="Ref"
                  style={{
                    width: 140,
                    height: 140,
                    objectFit: "contain",
                    borderRadius: 8,
                    border: `1px solid ${theme.border}`,
                    background: theme.surface,
                    flexShrink: 0,
                  }}
                />
              )}
              <div style={{ flex: 1, minWidth: 200 }}>
                <h3
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    marginBottom: 8,
                    marginTop: 0,
                  }}
                >
                  AI Analysis Summary
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    color: theme.textMuted,
                    margin: 0,
                  }}
                >
                  {analysis.summary}
                </p>
                <div
                  style={{
                    marginTop: 10,
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    background:
                      analysis.overallConfidence === "high"
                        ? `${theme.success}20`
                        : analysis.overallConfidence === "medium"
                          ? `${theme.warning}20`
                          : `${theme.danger}20`,
                    color:
                      analysis.overallConfidence === "high"
                        ? theme.success
                        : analysis.overallConfidence === "medium"
                          ? theme.warning
                          : theme.danger,
                  }}
                >
                  Confidence: {analysis.overallConfidence}
                  {analysis.confidenceNotes &&
                    ` — ${analysis.confidenceNotes}`}
                </div>
              </div>
            </div>

            {/* Element decisions */}
            <h4
              style={{
                fontSize: 13,
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                color: theme.textMuted,
                marginBottom: 12,
              }}
            >
              Design Decisions
            </h4>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginBottom: 20,
              }}
            >
              {analysis.elements?.map((el, i) => {
                const ac = {
                  keep: theme.success,
                  simplify: theme.warning,
                  merge: theme.accent,
                  drop: theme.danger,
                  enlarge: "#6CA6D9",
                  flag: theme.danger,
                };
                const col = ac[el.action] || theme.textMuted;
                return (
                  <div
                    key={i}
                    style={{
                      padding: "12px 16px",
                      background: theme.surface,
                      border: `1px solid ${theme.border}`,
                      borderRadius: 8,
                      borderLeft: `3px solid ${col}`,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 14 }}>
                        {el.name}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          fontWeight: 600,
                          textTransform: "uppercase",
                          padding: "2px 8px",
                          borderRadius: 4,
                          color: col,
                          background: `${col}18`,
                        }}
                      >
                        {el.action}
                      </span>
                    </div>
                    <p
                      style={{
                        fontSize: 13,
                        color: theme.textMuted,
                        margin: 0,
                        lineHeight: 1.5,
                      }}
                    >
                      {el.reason}
                    </p>
                    {el.details && (
                      <p
                        style={{
                          fontSize: 12,
                          color: theme.textDim,
                          margin: "4px 0 0",
                          fontStyle: "italic",
                        }}
                      >
                        {el.details}
                      </p>
                    )}
                    {el.printRisk && el.printRisk !== "none" && (
                      <span
                        style={{
                          display: "inline-block",
                          marginTop: 6,
                          fontSize: 11,
                          padding: "2px 6px",
                          borderRadius: 3,
                          background:
                            el.printRisk === "high"
                              ? `${theme.danger}20`
                              : `${theme.warning}20`,
                          color:
                            el.printRisk === "high"
                              ? theme.danger
                              : theme.warning,
                        }}
                      >
                        Print risk: {el.printRisk}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Ambiguities */}
            {analysis.ambiguities?.length > 0 && (
              <div style={{ marginBottom: 20 }}>
                <h4
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                    color: theme.warning,
                    marginBottom: 12,
                  }}
                >
                  Needs Your Input
                </h4>
                {analysis.ambiguities.map((amb, i) => (
                  <div
                    key={i}
                    style={{
                      padding: 16,
                      background: `${theme.warning}08`,
                      border: `1px solid ${theme.warning}30`,
                      borderRadius: 8,
                      marginBottom: 8,
                    }}
                  >
                    <p
                      style={{
                        fontWeight: 600,
                        fontSize: 14,
                        margin: "0 0 8px",
                      }}
                    >
                      {amb.element}
                    </p>
                    <div
                      style={{
                        fontSize: 13,
                        lineHeight: 1.6,
                        color: theme.textMuted,
                      }}
                    >
                      <div style={{ marginBottom: 4 }}>
                        <strong>Option A:</strong> {amb.optionA}
                      </div>
                      <div style={{ marginBottom: 4 }}>
                        <strong>Option B:</strong> {amb.optionB}
                      </div>
                      <div style={{ color: theme.accent }}>
                        <strong>Rec:</strong> {amb.recommendation}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Processing notes */}
            {analysis.processingInstructions?.notes && (
              <div
                style={{
                  padding: 12,
                  background: theme.surface,
                  borderRadius: 8,
                  border: `1px solid ${theme.border}`,
                  fontSize: 13,
                  color: theme.textMuted,
                  marginBottom: 20,
                }}
              >
                <strong>Processing notes:</strong>{" "}
                {analysis.processingInstructions.notes}
              </div>
            )}

            <div style={{ display: "flex", gap: 12 }}>
              <button onClick={generateBW} style={primaryBtn}>
                Approve & Generate B&W →
              </button>
              <button
                onClick={() => {
                  setStage("upload");
                  setAnalysis(null);
                }}
                style={ghostBtn}
              >
                Re-analyse
              </button>
            </div>
          </div>
        )}

        {/* ════════ B&W PREVIEW ════════ */}
        {stage === "bw-preview" && (
          <div>
            <h3
              style={{
                fontSize: 16,
                fontWeight: 600,
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              Black & White Preview
            </h3>
            <div
              style={{
                display: "flex",
                gap: 20,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <div
                style={{
                  flex: "1 1 300px",
                  background: theme.surface,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 8,
                  padding: 16,
                  textAlign: "center",
                }}
              >
                {bwCanvas && (
                  <img
                    src={bwCanvas}
                    alt="B&W"
                    style={{
                      maxWidth: "100%",
                      maxHeight: 300,
                      borderRadius: 4,
                    }}
                  />
                )}
              </div>
              <div style={{ flex: "0 0 200px" }}>
                <label
                  style={{
                    fontSize: 12,
                    color: theme.textMuted,
                    display: "block",
                    marginBottom: 6,
                  }}
                >
                  Threshold: {threshold}
                </label>
                <input
                  type="range"
                  min="1"
                  max="255"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  style={{ width: "100%", accentColor: theme.accent }}
                />
                <p
                  style={{
                    fontSize: 11,
                    color: theme.textDim,
                    marginTop: 4,
                    lineHeight: 1.4,
                  }}
                >
                  Lower = more black (more detail kept). Higher = more white
                  (simpler stamp).
                </p>
                <button
                  onClick={generateBW}
                  style={{
                    marginTop: 12,
                    width: "100%",
                    padding: "8px 12px",
                    background: theme.surfaceHover,
                    color: theme.text,
                    border: `1px solid ${theme.border}`,
                    borderRadius: 6,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  Regenerate
                </button>
              </div>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
              <button onClick={generateSVG} style={primaryBtn}>
                Trace to SVG →
              </button>
              <button onClick={() => setStage("review")} style={ghostBtn}>
                ← Back
              </button>
            </div>
          </div>
        )}

        {/* ════════ SVG PREVIEW ════════ */}
        {stage === "svg-preview" && (
          <div>
            <h3
              style={{
                fontSize: 16,
                fontWeight: 600,
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              SVG Trace Preview
            </h3>
            <div
              style={{
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                padding: 16,
                textAlign: "center",
              }}
            >
              <svg
                viewBox={`0 0 ${stampSize} ${stampSize}`}
                width={Math.min(400, stampSize * 5)}
                height={Math.min(400, stampSize * 5)}
                style={{ background: "#fff", borderRadius: 4 }}
              >
                <circle
                  cx={stampSize / 2}
                  cy={stampSize / 2}
                  r={stampSize / 2 - 0.5}
                  fill="none"
                  stroke="#ddd"
                  strokeWidth="0.5"
                  strokeDasharray="2,2"
                />
                {svgPath && (
                  <path d={svgPath} fill="#000" fillRule="evenodd" />
                )}
              </svg>
              <p
                style={{
                  fontSize: 12,
                  color: theme.textMuted,
                  marginTop: 8,
                }}
              >
                {svgContours?.length || 0} contours traced — dashed circle
                shows {stampSize}mm stamp boundary
              </p>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
              <button
                onClick={() => setStage("3d-preview")}
                style={primaryBtn}
              >
                Generate 3D Preview →
              </button>
              <button
                onClick={() => setStage("bw-preview")}
                style={ghostBtn}
              >
                ← Back
              </button>
            </div>
          </div>
        )}

        {/* ════════ 3D PREVIEW ════════ */}
        {stage === "3d-preview" && (
          <div>
            <h3
              style={{
                fontSize: 16,
                fontWeight: 600,
                marginBottom: 16,
                marginTop: 0,
              }}
            >
              3D Stamp Preview
            </h3>

            <div
              style={{
                background: theme.surface,
                border: `1px solid ${theme.border}`,
                borderRadius: 8,
                overflow: "hidden",
                marginBottom: 16,
              }}
            >
              <div
                ref={threeContainerRef}
                style={{ width: "100%", height: 400 }}
              />
            </div>

            {/* Controls */}
            <div
              style={{
                display: "flex",
                gap: 16,
                marginBottom: 20,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              <div>
                <label
                  style={{
                    fontSize: 12,
                    color: theme.textMuted,
                    display: "block",
                    marginBottom: 4,
                  }}
                >
                  Extrusion: {extrudeDepth}mm
                </label>
                <input
                  type="range"
                  min="0.5"
                  max="4"
                  step="0.1"
                  value={extrudeDepth}
                  onChange={(e) => setExtrudeDepth(Number(e.target.value))}
                  style={{ width: 180, accentColor: theme.accent }}
                />
              </div>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 13,
                  color: theme.textMuted,
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={includeBase}
                  onChange={(e) => setIncludeBase(e.target.checked)}
                />
                Include base plate ({STAMP_DEFAULTS.baseHeight}mm)
              </label>
              <button
                onClick={generate3D}
                style={{
                  padding: "6px 14px",
                  background: theme.surfaceHover,
                  color: theme.text,
                  border: `1px solid ${theme.border}`,
                  borderRadius: 6,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Regenerate 3D
              </button>
            </div>

            {/* Download + nav */}
            <div style={{ display: "flex", gap: 12 }}>
              <button
                onClick={downloadSTL}
                disabled={!stlBlob}
                style={{
                  ...primaryBtn,
                  background: stlBlob ? theme.success : theme.surfaceHover,
                  color: stlBlob ? theme.white : theme.textDim,
                  cursor: stlBlob ? "pointer" : "default",
                }}
              >
                ↓ Download STL
              </button>
              <button
                onClick={() => setStage("svg-preview")}
                style={ghostBtn}
              >
                ← Back
              </button>
            </div>

            <div
              style={{
                marginTop: 16,
                padding: 12,
                background: theme.surface,
                borderRadius: 8,
                border: `1px solid ${theme.border}`,
                fontSize: 12,
                color: theme.textDim,
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: theme.textMuted }}>Note:</strong> This
              STL contains the stamp face
              {includeBase
                ? " with base plate"
                : " only (no base plate)"}
              .
              {!includeBase &&
                " Combine with your standard handle in TinkerCAD."}
              {" "}Design is not mirrored — if text is present, mirror in your
              slicer or CAD tool before printing.
            </div>
          </div>
        )}

        {/* ════════ START OVER (always visible when past upload) ════════ */}
        {stage !== "upload" && stage !== "analyzing" && (
          <div style={{ marginTop: 32, textAlign: "center" }}>
            <button
              onClick={() => {
                setStage("upload");
                setImage(null);
                setImageBase64(null);
                setAnalysis(null);
                setAnalysisError(null);
                setBwCanvas(null);
                setBwImageData(null);
                setSvgPath(null);
                setSvgContours(null);
                setStlBlob(null);
                if (threeCleanupRef.current) {
                  threeCleanupRef.current();
                  threeCleanupRef.current = null;
                }
              }}
              style={{
                padding: "8px 20px",
                background: "transparent",
                color: theme.textDim,
                border: `1px solid ${theme.border}`,
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              Start over with new image
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
