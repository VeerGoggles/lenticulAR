/**
 * View zones — which scene(s) a viewer at horizontal view position `v` sees.
 *
 * `v` is the viewer's normalised position across the screen's viewing range:
 * 0 = far left, 1 = far right. With N scenes the range is cut into N rest
 * zones by N - 1 boundaries (default k / N, i.e. 1/3 and 2/3 for three
 * scenes). Around each boundary sits a transition band of ±halfWidth
 * (default 0.05, i.e. 5 % of the range before and after the boundary).
 *
 *   v:  0 ────── b1-h ▒▒▒▒ b1+h ────── b2-h ▒▒▒▒ b2+h ────── 1
 *        scene A   │ A→B band │  scene B  │ B→C band │  scene C
 *        1 pass       2 passes   1 pass      2 passes   1 pass
 *
 * Outside a band exactly one scene is visible (and is the only one that
 * needs rendering). Inside a band the prisms rotate from the outgoing
 * scene's face to the incoming one's, so exactly two scenes are visible.
 *
 * Everything here is pure and deterministic so the renderer, the HUD, the
 * tests and the results harness all agree on the same numbers.
 */

export const TAU = Math.PI * 2;

export const EASINGS = {
  linear: (t) => t,
  smoothstep: (t) => t * t * (3 - 2 * t),
  smootherstep: (t) => t * t * t * (t * (t * 6 - 15) + 10),
};

/** Index used by the GLSL compositor for each easing (see prismComposite.js). */
export const EASING_IDS = { linear: 0, smoothstep: 1, smootherstep: 2 };

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Number of faces on each prism. A prism needs one face per scene, and at
 * least three so that it is a real prism (two scenes use a triangular prism
 * with a spare face, exactly like a tri-vision sign showing two ads).
 */
export function faceCountFor(sceneCount) {
  return Math.max(3, sceneCount);
}

/**
 * Build and validate a view layout.
 *
 * @param {object}   opts
 * @param {number}   [opts.sceneCount=3]          number of scenes (>= 2)
 * @param {number[]} [opts.boundaries]            sorted scene boundaries in (0, 1); default k / N
 * @param {number}   [opts.transitionHalfWidth=0.05] half-width of each transition band
 */
export function createViewLayout({
  sceneCount = 3,
  boundaries,
  transitionHalfWidth = 0.05,
} = {}) {
  if (!Number.isInteger(sceneCount) || sceneCount < 2) {
    throw new RangeError(`sceneCount must be an integer >= 2 (got ${sceneCount})`);
  }
  const b =
    boundaries ?? Array.from({ length: sceneCount - 1 }, (_, k) => (k + 1) / sceneCount);
  if (b.length !== sceneCount - 1) {
    throw new RangeError(`expected ${sceneCount - 1} boundaries, got ${b.length}`);
  }
  const h = transitionHalfWidth;
  if (!(h >= 0)) throw new RangeError(`transitionHalfWidth must be >= 0 (got ${h})`);

  const EPS = 1e-9;
  const bands = b.map((center, k) => {
    const start = center - h;
    const end = center + h;
    if (start < -EPS || end > 1 + EPS) {
      throw new RangeError(
        `transition band ${k} [${start.toFixed(3)}, ${end.toFixed(3)}] leaves the 0..1 view range`
      );
    }
    if (k > 0 && start < b[k - 1] + h - EPS) {
      throw new RangeError(
        `transition bands ${k - 1} and ${k} overlap; reduce transitionHalfWidth or spread the boundaries`
      );
    }
    return { index: k, from: k, to: k + 1, center, start, end };
  });

  return {
    sceneCount,
    faceCount: faceCountFor(sceneCount),
    boundaries: b,
    halfWidth: h,
    bands,
  };
}

/**
 * Evaluate the layout at view position v.
 *
 * @returns {{
 *   v: number,              // clamped view position
 *   zone: 'rest' | 'transition',
 *   band: number,           // band index, -1 at rest
 *   from: number,           // outgoing scene (== to at rest)
 *   to: number,             // incoming scene
 *   scene: number,          // dominant scene (whichever face covers more of the prism)
 *   progress: number,       // linear progress through the band, 0..1 (0 at rest)
 *   eased: number,          // eased progress, 0..1
 *   active: number[],       // scenes that must be rendered: [k] or [from, to]
 *   prismTurns: number,     // global prism rotation in face steps (k + eased)
 *   prismAngle: number,     // same in radians: prismTurns * 2π / faceCount
 * }}
 */
export function evaluateView(layout, v, { easing = "smoothstep" } = {}) {
  const ease = EASINGS[easing];
  if (!ease) throw new RangeError(`unknown easing "${easing}"`);
  const vc = clamp01(Number.isFinite(v) ? v : 0.5);
  const step = TAU / layout.faceCount;

  for (const band of layout.bands) {
    // open interval: exactly on the band edge the prisms are at rest
    if (vc > band.start && vc < band.end) {
      const progress = band.end > band.start ? (vc - band.start) / (band.end - band.start) : 0;
      const eased = ease(progress);
      return {
        v: vc,
        zone: "transition",
        band: band.index,
        from: band.from,
        to: band.to,
        scene: eased < 0.5 ? band.from : band.to,
        progress,
        eased,
        active: [band.from, band.to],
        prismTurns: band.from + eased,
        prismAngle: (band.from + eased) * step,
      };
    }
  }

  let scene = 0;
  for (const center of layout.boundaries) if (vc >= center) scene += 1;
  return {
    v: vc,
    zone: "rest",
    band: -1,
    from: scene,
    to: scene,
    scene,
    progress: 0,
    eased: 0,
    active: [scene],
    prismTurns: scene,
    prismAngle: scene * step,
  };
}

/**
 * Per-prism progress for a staggered ("sweeping") flip.
 *
 * A real lenticular sheet seen from a finite distance does not flip all at
 * once: each lenslet sees the viewer at a slightly different angle, so the
 * flip line sweeps across the print in the direction the viewer moves.
 * `stagger` reproduces that. 0 = every prism turns in lockstep; 1 = the
 * sweep takes as long as a single prism's turn. Whatever the stagger, every
 * prism is at rest at progress 0 and has finished at progress 1, so the
 * band edges stay seamless and the 1-scene / 2-scene schedule still holds.
 *
 * @param {number} progress  global band progress, 0..1
 * @param {number} xhat      prism centre as a fraction of the screen width, 0..1
 * @param {number} stagger   sweep amount; negative sweeps right-to-left
 */
export function prismProgress(progress, xhat, stagger = 0) {
  if (!stagger) return clamp01(progress);
  const k = Math.abs(stagger);
  const x = stagger > 0 ? xhat : 1 - xhat;
  return clamp01(progress * (1 + k) - k * x);
}

/**
 * Map a viewer's eye position (display space, cm, origin at screen centre,
 * +z towards the viewer) to a view position v. Angle-based, like a real
 * lenticular: which image you see depends on the angle you view from, not on
 * how far away you are.
 */
export function viewFromEye(eye, viewConeRad) {
  const z = Math.max(1e-3, eye.z);
  return 0.5 + Math.atan2(eye.x, z) / viewConeRad;
}

/** Inverse of viewFromEye for a given viewing distance. */
export function eyeXFromView(v, distance, viewConeRad) {
  return distance * Math.tan((v - 0.5) * viewConeRad);
}

/**
 * The render schedule for a frame: which scenes are drawn, and whether the
 * prism compositor runs. `lazy` is the lenticulAR schedule; `always` is the
 * naive one (render every scene, every frame) kept for benchmarking.
 */
export function renderSchedule(view, sceneCount, scheduling = "lazy") {
  if (scheduling === "always") {
    return {
      scenes: Array.from({ length: sceneCount }, (_, k) => k),
      composite: true,
    };
  }
  return {
    scenes: view.active.slice(),
    composite: view.zone === "transition",
  };
}
