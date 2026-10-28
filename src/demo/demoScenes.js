/**
 * Three procedurally drawn colour + depth-map pairs, so the demo runs with no
 * bundled assets (the same approach as pARelax's demoImage.js). Each scene
 * is a stack of silhouette layers; the depth map paints every layer with its
 * own grey (white = near, black = far — the MiDaS convention), so the
 * displaced mesh separates the layers and they parallax against each other.
 *
 * The palettes are deliberately far apart (warm dusk / teal pines / violet
 * night city) so that during a transition it is always obvious which strips
 * belong to which scene. Swap these for real photos + depth maps (see the
 * README) — the engine takes any { map, depthMap } pair.
 */

const DEFAULT_SIZE = { width: 2048, height: 1152 };
const DEPTH_SCALE = 0.5; // depth maps are drawn at half resolution, the mesh is far coarser anyway

/* ---------------------------------------------------------------- helpers */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise1D(rand, size = 512) {
  const v = Array.from({ length: size }, rand);
  return (x) => {
    const i = Math.floor(x);
    const f = x - i;
    const a = v[((i % size) + size) % size];
    const b = v[(((i + 1) % size) + size) % size];
    const t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
  };
}

function fbm(noise, x, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq + o * 17.3);
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

function makeCanvas(width, height) {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  return c;
}

const grey = (d) => {
  const g = Math.round(Math.max(0, Math.min(1, d)) * 255);
  return `rgb(${g},${g},${g})`;
};

/**
 * A scene is drawn once into a "colour" context and once into a "depth"
 * context at a smaller scale; `paint(layerDepth, drawFn)` keeps them in sync.
 */
function createPainter({ width, height }) {
  const color = makeCanvas(width, height);
  const depth = makeCanvas(Math.round(width * DEPTH_SCALE), Math.round(height * DEPTH_SCALE));
  const cc = color.getContext("2d");
  const dc = depth.getContext("2d");
  dc.scale(DEPTH_SCALE, DEPTH_SCALE);
  dc.fillStyle = "#000";
  dc.fillRect(0, 0, width, height);

  return {
    color,
    depth,
    cc,
    W: width,
    H: height,
    /** Draw a shape into both maps: `fill` colours the picture, `d` sets its depth. */
    paint(fill, d, pathFn) {
      cc.beginPath();
      pathFn(cc);
      cc.fillStyle = fill;
      cc.fill();
      if (d !== null && d !== undefined) {
        dc.beginPath();
        pathFn(dc);
        dc.fillStyle = grey(d);
        dc.fill();
      }
    },
    /**
     * Grow near layers a few pixels (a max filter), then soften. Where the
     * displaced mesh has to ramp between two layers, the ramp then falls on
     * the far side of the edge, so it stretches the soft background rather
     * than smearing the crisp silhouette in front of it.
     */
    finish(blurPx = 2.5, dilatePx = 4) {
      const grown = makeCanvas(depth.width, depth.height);
      const gc = grown.getContext("2d");
      gc.drawImage(depth, 0, 0);
      gc.globalCompositeOperation = "lighten";
      for (let a = 0; a < 16; a++) {
        const ang = (a / 16) * Math.PI * 2;
        for (const r of [dilatePx / 2, dilatePx]) {
          gc.drawImage(depth, Math.cos(ang) * r, Math.sin(ang) * r);
        }
      }
      const soft = makeCanvas(depth.width, depth.height);
      const sc = soft.getContext("2d");
      sc.filter = `blur(${blurPx}px)`;
      sc.drawImage(grown, 0, 0);
      sc.filter = "none";
      return soft;
    },
  };
}

function ridgePath(noise, { W, H, base, amp, freq, octaves = 4, phase = 0, step = 6 }) {
  return (ctx) => {
    ctx.moveTo(0, H + 10);
    for (let x = 0; x <= W + step; x += step) {
      const y = base * H - amp * H * fbm(noise, (x / W) * freq + phase, octaves);
      ctx.lineTo(x, y);
    }
    ctx.lineTo(W + step, H + 10);
    ctx.closePath();
  };
}

function verticalGradient(ctx, H, stops) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  stops.forEach(([t, c]) => g.addColorStop(t, c));
  return g;
}

function hazeBand(cc, W, H, y, height, color) {
  const g = cc.createLinearGradient(0, y - height, 0, y + height * 0.3);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(0.7, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  cc.fillStyle = g;
  cc.fillRect(0, y - height, W, height * 1.3);
}

function label(cc, W, H, text, accent) {
  const s = H / 1152;
  const pad = 26 * s;
  cc.save();
  cc.font = `700 ${34 * s}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const tw = cc.measureText(text).width;
  // inset well inside the frame: the window shows the central ~80 % of the picture
  const x = 0.15 * W;
  const y = 0.14 * H;
  const w = tw + pad * 2 + 22 * s;
  const h = 60 * s;
  cc.fillStyle = "rgba(8, 6, 16, 0.55)";
  cc.beginPath();
  cc.roundRect ? cc.roundRect(x, y, w, h, h / 2) : cc.rect(x, y, w, h);
  cc.fill();
  cc.fillStyle = accent;
  cc.beginPath();
  cc.arc(x + pad + 4 * s, y + h / 2, 7 * s, 0, Math.PI * 2);
  cc.fill();
  cc.fillStyle = "rgba(255,255,255,0.92)";
  cc.textBaseline = "middle";
  cc.fillText(text, x + pad + 22 * s, y + h / 2 + 1 * s);
  cc.restore();
}

/* ----------------------------------------------------------------- scenes */

function drawDusk(size) {
  const p = createPainter(size);
  const { cc, W, H } = p;
  const rand = mulberry32(11);
  const noise = valueNoise1D(rand);

  cc.fillStyle = verticalGradient(cc, H, [
    [0, "#170a33"],
    [0.28, "#4a1a5c"],
    [0.48, "#a83a6a"],
    [0.62, "#ec7d5c"],
    [0.74, "#ffc98f"],
    [1, "#ffe2b0"],
  ]);
  cc.fillRect(0, 0, W, H);

  // sun + glow
  const sx = 0.64 * W;
  const sy = 0.6 * H;
  const glow = cc.createRadialGradient(sx, sy, 0, sx, sy, 0.42 * H);
  glow.addColorStop(0, "rgba(255,236,190,0.95)");
  glow.addColorStop(0.18, "rgba(255,200,140,0.55)");
  glow.addColorStop(1, "rgba(255,160,120,0)");
  cc.fillStyle = glow;
  cc.fillRect(0, 0, W, H);
  cc.fillStyle = "#fff1cf";
  cc.beginPath();
  cc.arc(sx, sy, 0.075 * H, 0, Math.PI * 2);
  cc.fill();

  // long thin clouds
  for (let i = 0; i < 9; i++) {
    const cy = (0.12 + rand() * 0.38) * H;
    const cx = rand() * W;
    const w = (0.18 + rand() * 0.3) * W;
    cc.fillStyle = `rgba(255, ${170 + Math.round(rand() * 40)}, 150, ${0.12 + rand() * 0.16})`;
    cc.beginPath();
    cc.ellipse(cx, cy, w / 2, (0.006 + rand() * 0.01) * H, 0, 0, Math.PI * 2);
    cc.fill();
  }

  const layers = [
    { base: 0.66, amp: 0.15, freq: 2.2, color: "#c0577a", depth: 0.16, haze: "rgba(255,190,150,0.35)" },
    { base: 0.72, amp: 0.15, freq: 3.1, color: "#93366a", depth: 0.34, haze: "rgba(240,140,130,0.30)" },
    { base: 0.8, amp: 0.16, freq: 2.6, color: "#64224f", depth: 0.55, haze: "rgba(200,90,110,0.26)" },
    { base: 0.9, amp: 0.15, freq: 3.4, color: "#3c1238", depth: 0.76, haze: "rgba(120,40,80,0.22)" },
    { base: 1.0, amp: 0.13, freq: 2.0, color: "#1c0920", depth: 0.96, haze: null },
  ];
  layers.forEach((l, k) => {
    p.paint(l.color, l.depth, ridgePath(noise, { W, H, base: l.base, amp: l.amp, freq: l.freq, phase: k * 3.7 }));
    if (l.haze) hazeBand(cc, W, H, l.base * H - 0.02 * H, 0.08 * H, l.haze);
  });

  label(cc, W, H, "A · DUSK", "#ffb36b");
  return { map: p.color, depthMap: p.finish(), label: "A · Dusk", accent: "#ffb36b" };
}

function pineTree(ctx, x, yBase, h, w) {
  const tiers = 4;
  for (let t = 0; t < tiers; t++) {
    const ty = yBase - (h * t) / (tiers + 0.4);
    const tw = w * (1 - t / (tiers + 0.6));
    ctx.moveTo(x - tw / 2, ty);
    ctx.lineTo(x, ty - h * 0.42);
    ctx.lineTo(x + tw / 2, ty);
    ctx.closePath();
  }
  ctx.rect(x - w * 0.05, yBase - h * 0.05, w * 0.1, h * 0.12);
}

function forestPath(noise, rand, { W, H, base, amp, freq, phase, treeH, treeW, density }) {
  // pre-roll the trees so the colour and depth passes draw identical shapes
  const trees = [];
  let x = -treeW;
  while (x < W + treeW) {
    const ground = base * H - amp * H * fbm(noise, (x / W) * freq + phase, 3);
    const h = treeH * H * (0.65 + rand() * 0.7);
    trees.push([x, ground + h * 0.05, h, treeW * H * (0.75 + rand() * 0.5)]);
    x += (treeW * H) / density * (0.5 + rand());
  }
  const ridge = ridgePath(noise, { W, H, base, amp, freq, phase, octaves: 3 });
  return (ctx) => {
    ridge(ctx);
    for (const [tx, ty, th, tw] of trees) pineTree(ctx, tx, ty, th, tw);
  };
}

function drawPines(size) {
  const p = createPainter(size);
  const { cc, W, H } = p;
  const rand = mulberry32(23);
  const noise = valueNoise1D(rand);

  cc.fillStyle = verticalGradient(cc, H, [
    [0, "#061a26"],
    [0.3, "#0f3d4c"],
    [0.55, "#2c7a7d"],
    [0.72, "#86c9b6"],
    [1, "#d8f0df"],
  ]);
  cc.fillRect(0, 0, W, H);

  // stars
  for (let i = 0; i < 160; i++) {
    cc.fillStyle = `rgba(230,255,245,${0.15 + rand() * 0.55})`;
    const r = (0.6 + rand() * 1.4) * (H / 1152);
    cc.beginPath();
    cc.arc(rand() * W, rand() * 0.38 * H, r, 0, Math.PI * 2);
    cc.fill();
  }

  // moon + halo
  const mx = 0.23 * W;
  const my = 0.24 * H;
  const halo = cc.createRadialGradient(mx, my, 0, mx, my, 0.3 * H);
  halo.addColorStop(0, "rgba(235,255,240,0.55)");
  halo.addColorStop(0.25, "rgba(200,240,225,0.18)");
  halo.addColorStop(1, "rgba(200,240,225,0)");
  cc.fillStyle = halo;
  cc.fillRect(0, 0, W, H);
  cc.fillStyle = "#f2fbef";
  cc.beginPath();
  cc.arc(mx, my, 0.055 * H, 0, Math.PI * 2);
  cc.fill();

  // far mountains
  p.paint(
    "#5f9f97",
    0.12,
    ridgePath(noise, { W, H, base: 0.62, amp: 0.26, freq: 1.6, phase: 4.1, octaves: 5 })
  );
  hazeBand(cc, W, H, 0.6 * H, 0.1 * H, "rgba(210,245,230,0.40)");

  const layers = [
    { base: 0.7, amp: 0.06, color: "#3f7f79", depth: 0.3, treeH: 0.1, treeW: 0.032, density: 1.6, mist: "rgba(200,240,225,0.32)" },
    { base: 0.8, amp: 0.07, color: "#245e5c", depth: 0.5, treeH: 0.15, treeW: 0.046, density: 1.5, mist: "rgba(170,225,210,0.26)" },
    { base: 0.91, amp: 0.07, color: "#123f40", depth: 0.72, treeH: 0.22, treeW: 0.066, density: 1.35, mist: "rgba(120,190,180,0.20)" },
    { base: 1.04, amp: 0.06, color: "#04201f", depth: 0.95, treeH: 0.36, treeW: 0.1, density: 1.15, mist: null },
  ];
  layers.forEach((l, k) => {
    p.paint(
      l.color,
      l.depth,
      forestPath(noise, rand, { W, H, base: l.base, amp: l.amp, freq: 2.4 + k, phase: k * 5.3, treeH: l.treeH, treeW: l.treeW, density: l.density })
    );
    if (l.mist) hazeBand(cc, W, H, l.base * H - 0.01 * H, 0.07 * H, l.mist);
  });

  label(cc, W, H, "B · PINES", "#7fe0c6");
  return { map: p.color, depthMap: p.finish(), label: "B · Pines", accent: "#7fe0c6" };
}

function skylinePath(rand, { W, H, base, minH, maxH, minW, maxW }) {
  const blocks = [];
  let x = -rand() * maxW * W;
  while (x < W) {
    const w = (minW + rand() * (maxW - minW)) * W;
    const h = (minH + rand() * (maxH - minH)) * H;
    const antenna = rand() < 0.18 ? h * (0.15 + rand() * 0.25) : 0;
    blocks.push({ x, w, h, antenna });
    x += w * (0.86 + rand() * 0.2);
  }
  const path = (ctx) => {
    for (const b of blocks) {
      ctx.rect(b.x, base * H - b.h, b.w, b.h + H);
      if (b.antenna) ctx.rect(b.x + b.w * 0.48, base * H - b.h - b.antenna, Math.max(2, b.w * 0.04), b.antenna);
    }
  };
  return { blocks, path };
}

function windows(cc, rand, blocks, base, H, { palette, chance, alpha, cell }) {
  const cw = cell * H;
  for (const b of blocks) {
    const top = base * H - b.h;
    for (let y = top + cw; y < base * H + H * 0.1; y += cw * 1.6) {
      for (let x = b.x + cw * 0.8; x < b.x + b.w - cw * 0.8; x += cw * 1.4) {
        if (rand() < chance) {
          cc.fillStyle = palette[Math.floor(rand() * palette.length)];
          cc.globalAlpha = alpha * (0.5 + rand() * 0.5);
          cc.fillRect(x, y, cw * 0.7, cw);
        }
      }
    }
  }
  cc.globalAlpha = 1;
}

function drawNeon(size) {
  const p = createPainter(size);
  const { cc, W, H } = p;
  const rand = mulberry32(37);

  cc.fillStyle = verticalGradient(cc, H, [
    [0, "#05030f"],
    [0.35, "#160b36"],
    [0.6, "#3d1665"],
    [0.78, "#7a2a86"],
    [1, "#b24a8e"],
  ]);
  cc.fillRect(0, 0, W, H);

  for (let i = 0; i < 260; i++) {
    cc.fillStyle = `rgba(255,240,255,${0.1 + rand() * 0.6})`;
    const r = (0.5 + rand() * 1.3) * (H / 1152);
    cc.beginPath();
    cc.arc(rand() * W, rand() * 0.55 * H, r, 0, Math.PI * 2);
    cc.fill();
  }

  // ringed planet
  const px = 0.75 * W;
  const py = 0.26 * H;
  const pr = 0.11 * H;
  const ring = (front) => {
    cc.save();
    cc.translate(px, py);
    cc.rotate(-0.32);
    cc.strokeStyle = "rgba(255,190,240,0.55)";
    cc.lineWidth = 0.012 * H;
    cc.beginPath();
    cc.ellipse(0, 0, pr * 1.9, pr * 0.42, 0, front ? 0 : Math.PI, front ? Math.PI : Math.PI * 2);
    cc.stroke();
    cc.restore();
  };
  ring(false);
  const pg = cc.createLinearGradient(px - pr, py - pr, px + pr, py + pr);
  pg.addColorStop(0, "#ffa6dc");
  pg.addColorStop(0.55, "#9b5be0");
  pg.addColorStop(1, "#2f1b6e");
  cc.fillStyle = pg;
  cc.beginPath();
  cc.arc(px, py, pr, 0, Math.PI * 2);
  cc.fill();
  ring(true);

  hazeBand(cc, W, H, 0.74 * H, 0.16 * H, "rgba(255,120,200,0.22)");

  const layers = [
    { base: 0.76, minH: 0.12, maxH: 0.3, minW: 0.03, maxW: 0.07, color: "#3a2063", depth: 0.2, win: { palette: ["#a98bff", "#ff9be3"], chance: 0.25, alpha: 0.45, cell: 0.008 }, haze: "rgba(200,90,190,0.30)" },
    { base: 0.84, minH: 0.14, maxH: 0.38, minW: 0.045, maxW: 0.1, color: "#25124a", depth: 0.42, win: { palette: ["#ff9be3", "#7fe8ff", "#ffd36b"], chance: 0.3, alpha: 0.7, cell: 0.011 }, haze: "rgba(160,60,170,0.26)" },
    { base: 0.93, minH: 0.16, maxH: 0.45, minW: 0.06, maxW: 0.13, color: "#170a33", depth: 0.66, win: { palette: ["#ffd36b", "#6be4ff", "#ff6bd5"], chance: 0.36, alpha: 0.9, cell: 0.015 }, haze: "rgba(90,30,110,0.24)" },
  ];
  layers.forEach((l) => {
    const { blocks, path } = skylinePath(rand, { W, H, base: l.base, minH: l.minH, maxH: l.maxH, minW: l.minW, maxW: l.maxW });
    p.paint(l.color, l.depth, path);
    windows(cc, rand, blocks, l.base, H, l.win);
    if (l.haze) hazeBand(cc, W, H, l.base * H - 0.01 * H, 0.06 * H, l.haze);
  });

  // foreground rooftop with a neon sign
  p.paint("#0a0418", 0.95, (ctx) => {
    ctx.moveTo(0, H + 10);
    ctx.lineTo(0, 0.9 * H);
    ctx.lineTo(0.18 * W, 0.9 * H);
    ctx.lineTo(0.18 * W, 0.86 * H);
    ctx.lineTo(0.42 * W, 0.86 * H);
    ctx.lineTo(0.42 * W, 0.93 * H);
    ctx.lineTo(W, 0.93 * H);
    ctx.lineTo(W, H + 10);
    ctx.closePath();
  });
  for (let x = 0.02 * W; x < W; x += 0.03 * W) {
    const top = x < 0.18 * W ? 0.9 : x < 0.42 * W ? 0.86 : 0.93;
    p.paint("#0a0418", 0.95, (ctx) => ctx.rect(x, (top - 0.035) * H, 0.004 * W, 0.035 * H));
  }
  p.paint("#0a0418", 0.95, (ctx) => {
    ctx.rect(0, 0.855 * H, 0.18 * W, 0.006 * H);
    ctx.rect(0.42 * W, 0.895 * H, 0.58 * W, 0.006 * H);
  });
  cc.save();
  cc.shadowColor = "#ff4fd8";
  cc.shadowBlur = 0.03 * H;
  cc.strokeStyle = "#ff8fe6";
  cc.lineWidth = 0.006 * H;
  cc.strokeRect(0.24 * W, 0.775 * H, 0.12 * W, 0.06 * H);
  cc.fillStyle = "#ffd6f6";
  cc.font = `800 ${0.036 * H}px system-ui, sans-serif`;
  cc.textAlign = "center";
  cc.textBaseline = "middle";
  cc.fillText("OPEN 24H", 0.3 * W, 0.806 * H);
  cc.restore();
  p.paint("rgba(0,0,0,0)", 0.95, (ctx) => ctx.rect(0.24 * W, 0.775 * H, 0.12 * W, 0.085 * H));

  label(cc, W, H, "C · NEON", "#c08bff");
  return { map: p.color, depthMap: p.finish(), label: "C · Neon", accent: "#c08bff" };
}

/**
 * @returns {{map: HTMLCanvasElement, depthMap: HTMLCanvasElement, label: string, accent: string}[]}
 */
export function generateDemoScenes(size = DEFAULT_SIZE) {
  return [drawDusk(size), drawPines(size), drawNeon(size)];
}
