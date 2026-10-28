import * as THREE from "three";
import ParallaxScene from "./ParallaxScene";
import PrismCompositor, { DEFAULT_PRISM_OPTIONS } from "./PrismCompositor";
import { updateOffAxisCamera } from "./headCoupledCamera";
import { createTracker } from "./trackers";
import {
  createViewLayout,
  evaluateView,
  renderSchedule,
  viewFromEye,
  eyeXFromView,
} from "./viewZones";

const DEG = Math.PI / 180;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export const DEFAULT_OPTIONS = {
  /** half-width of each transition band, as a fraction of the view range (±5 %) */
  transitionHalfWidth: 0.05,
  /** scene boundaries in 0..1; default k / N (1/3 and 2/3 for three scenes) */
  boundaries: null,
  easing: "smoothstep",
  prism: DEFAULT_PRISM_OPTIONS,
  /** viewing angle mapped onto v = 0..1 (face tracking); a real lenticular's "view cone" */
  viewConeDeg: 40,
  /** gain on the eye offset used for parallax (1 = physically correct for face tracking) */
  parallax: 0.6,
  /** time constant of the head-position smoothing, ms (0 = off) */
  smoothingMs: 70,
  /** "lazy": render only the visible scene(s). "always": every scene, every frame (benchmark baseline) */
  scheduling: "lazy",
  /** physical display model; anything left null is estimated from the canvas size */
  display: {
    widthCm: null,
    viewerDistanceCm: null,
    backCm: null, // far (black) plane distance behind the screen
    reliefCm: null, // how far a white depth pixel comes forward
  },
  pixelRatio: null,
  preserveDrawingBuffer: false,
  /**
   * Read back one pixel after each frame so frameMs includes the GPU work
   * (benchmarking only — it stalls the pipeline). gl.finish() is not enough:
   * Chrome only flushes on it, it does not wait for the GPU.
   */
  syncTimings: false,
};

function mergeOptions(base, patch = {}) {
  return {
    ...base,
    ...patch,
    prism: { ...base.prism, ...(patch.prism || {}) },
    display: { ...base.display, ...(patch.display || {}) },
  };
}

/**
 * lenticulAR: fake a lenticular print on an ordinary screen.
 *
 * Several depth-mapped parallax scenes (the pARelax technique) share one
 * head-coupled camera. The viewer's horizontal position picks which scene is
 * visible, exactly as viewing angle does on a lenticular print; around each
 * scene boundary a row of rotating prisms masks one scene out and the next
 * one in. Only the scenes that can be seen are rendered: one at rest, two
 * while the prisms turn.
 */
export default class LenticularEngine {
  /**
   * @param {object} options             see DEFAULT_OPTIONS, plus:
   * @param {HTMLElement} options.container
   * @param {object[]} options.scenes    [{ map, depthMap, depth?, label? }, ...] (2–6; 3 is the design point)
   * @param {(stats:object)=>void} [options.onFrame]
   * @param {(status:object)=>void} [options.onStatus]
   */
  constructor({ container, scenes, onFrame, onStatus, ...rest }) {
    if (!container) throw new Error("LenticularEngine needs a container element");
    if (!Array.isArray(scenes) || scenes.length < 2 || scenes.length > 6) {
      throw new RangeError("LenticularEngine needs between 2 and 6 scenes");
    }
    this.container = container;
    this.onFrame = onFrame;
    this.onStatus = onStatus;
    this.options = mergeOptions(DEFAULT_OPTIONS, rest);

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // keeps the direct path and the composited path pixel-identical at rest
      alpha: false,
      preserveDrawingBuffer: this.options.preserveDrawingBuffer,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setPixelRatio(this.options.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.renderer.domElement;
    Object.assign(canvas.style, { display: "block", width: "100%", height: "100%", touchAction: "none" });
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera();
    this.compositor = new PrismCompositor();
    this.scenes = scenes.map((desc) => new ParallaxScene(desc));
    this.targets = [];
    this.tracker = null;
    this.eye = null;
    this.lastTime = 0;
    this.frame = 0;
    this.loaded = false;
    this.running = false;
    this.wasTracking = null;
    this.drawingBuffer = new THREE.Vector2();

    this._applyLayout();
    this._loop = (t) => this.renderFrame(t);
    this._onResize = () => this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(this._onResize);
      this.resizeObserver.observe(container);
    } else {
      window.addEventListener("resize", this._onResize);
    }
    this.resize();
  }

  /* ------------------------------------------------------------ lifecycle */

  async load() {
    if (!this.loaded) {
      await Promise.all(this.scenes.map((s) => s.load()));
      this.loaded = true;
      this.resize();
    }
    return this;
  }

  /**
   * @param {"face"|"pointer"|"manual"|object} [tracking="pointer"]
   * @param {object} [trackerOptions]
   */
  async start(tracking = "pointer", trackerOptions = {}) {
    await this.load();
    await this.setTracker(tracking, trackerOptions);
    if (!this.running) {
      this.running = true;
      this.lastTime = 0;
      this.renderer.setAnimationLoop(this._loop);
    }
    return this;
  }

  async setTracker(tracking, trackerOptions = {}) {
    const next = createTracker(tracking, trackerOptions);
    await next.start(); // throws if e.g. the camera is refused; the current tracker keeps running
    this.tracker?.stop();
    this.tracker = next;
    this.eye = null; // snap to the new tracker's first pose
    this.wasTracking = null;
    this.onStatus?.({ type: "tracker", source: next.source });
    return next;
  }

  stop() {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.tracker?.stop();
    this.tracker = null;
  }

  dispose() {
    this.stop();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this._onResize);
    this.scenes.forEach((s) => s.dispose());
    this.targets.forEach((t) => t.dispose());
    this.compositor.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /* --------------------------------------------------------------- config */

  /** Change any option at runtime (prism look, bands, scheduling, ...). */
  setOptions(patch) {
    this.options = mergeOptions(this.options, patch);
    if ("pixelRatio" in patch && patch.pixelRatio) this.renderer.setPixelRatio(patch.pixelRatio);
    this._applyLayout();
    this.resize();
  }

  /** Drive the view position directly (pointer / manual trackers). */
  setViewPosition(v, vy) {
    if (typeof this.tracker?.set === "function") this.tracker.set(v, vy);
  }

  _applyLayout() {
    const { transitionHalfWidth, boundaries, prism, easing } = this.options;
    this.layout = createViewLayout({
      sceneCount: this.scenes.length,
      boundaries: boundaries ?? undefined,
      transitionHalfWidth,
    });
    this.compositor.configure(prism, this.layout.faceCount, easing);
  }

  /** Physical display model in cm, filled in from the canvas where not given. */
  _display() {
    const d = this.options.display;
    const cssW = this.container.clientWidth || window.innerWidth || 1280;
    const cssH = this.container.clientHeight || window.innerHeight || 720;
    // ~96 CSS px per inch is right for desktops and generous for phones; override when it matters
    const widthCm = d.widthCm ?? clamp((cssW / 96) * 2.54, 8, 60);
    const heightCm = widthCm * (cssH / cssW);
    const distance = d.viewerDistanceCm ?? clamp(widthCm * 1.6, 28, 65);
    return {
      widthCm,
      heightCm,
      distance,
      // shallow enough that the window shows ~80 % of each picture at the nominal eye
      backCm: d.backCm ?? widthCm * 0.4,
      reliefCm: d.reliefCm ?? widthCm * 0.3,
    };
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth || 1;
    const h = this.container.clientHeight || window.innerHeight || 1;
    this.renderer.setSize(w, h, false);
    this.renderer.getDrawingBufferSize(this.drawingBuffer);
    const { x: bw, y: bh } = this.drawingBuffer;
    this.targets.forEach((t) => t.setSize(bw, bh));
    this.compositor.setSize(bw, bh);

    const disp = this._display();
    const cone = this.options.viewConeDeg * DEG;
    this.display = disp;
    // The camera never goes further than this, so the pictures can be sized to
    // never show an edge (ParallaxScene.layout) without over-cropping them.
    this.eyeLimits = {
      x: disp.distance * Math.tan(cone / 2) * this.options.parallax * 1.05,
      y: disp.heightCm * 0.35,
      minZ: disp.distance * 0.85,
    };
    for (const s of this.scenes) {
      s.layout({
        screenW: disp.widthCm,
        screenH: disp.heightCm,
        backCm: disp.backCm,
        reliefCm: disp.reliefCm,
        maxEyeX: this.eyeLimits.x,
        maxEyeY: this.eyeLimits.y,
        minEyeZ: this.eyeLimits.minZ,
        distance: disp.distance,
      });
    }
    if (this.loaded && !this.running) this.renderFrame(performance.now());
  }

  _target(slot) {
    if (!this.targets[slot]) {
      const { x, y } = this.drawingBuffer;
      // sRGB storage keeps 8-bit precision where the eye needs it; sampling decodes back to linear
      this.targets[slot] = new THREE.WebGLRenderTarget(x, y, {
        colorSpace: this.renderer.capabilities.isWebGL2 ? THREE.SRGBColorSpace : THREE.NoColorSpace,
        depthBuffer: true,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
    }
    return this.targets[slot];
  }

  /* ---------------------------------------------------------------- frame */

  _targetEye(pose) {
    const disp = this.display;
    const cone = this.options.viewConeDeg * DEG;
    if (pose.eye) {
      return { x: pose.eye.x, y: pose.eye.y, z: clamp(pose.eye.z, 15, 400) };
    }
    return {
      x: eyeXFromView(pose.v ?? 0.5, disp.distance, cone),
      y: (0.5 - (pose.vy ?? 0.5)) * disp.heightCm * 0.6,
      z: disp.distance,
    };
  }

  /**
   * Render one frame. Called by the animation loop; call it directly for
   * deterministic captures (with a manual tracker and smoothingMs: 0).
   */
  renderFrame(now = performance.now()) {
    if (!this.loaded) return null;
    const opts = this.options;
    const dt = this.lastTime ? Math.min(0.1, (now - this.lastTime) / 1000) : 0;
    this.lastTime = now;

    // 1. where is the viewer?
    const pose = this.tracker?.getPose() ?? { v: 0.5, vy: 0.5, tracking: false };
    if (pose.tracking !== this.wasTracking) {
      this.wasTracking = pose.tracking;
      this.onStatus?.({ type: "tracking", tracking: pose.tracking });
    }
    const target = this._targetEye(pose);
    if (!this.eye || opts.smoothingMs <= 0) {
      this.eye = { ...target };
    } else if (dt > 0) {
      const a = 1 - Math.exp((-dt * 1000) / opts.smoothingMs);
      this.eye.x += (target.x - this.eye.x) * a;
      this.eye.y += (target.y - this.eye.y) * a;
      this.eye.z += (target.z - this.eye.z) * a;
    }

    // 2. which scene(s) does that angle see?
    const cone = opts.viewConeDeg * DEG;
    const v = viewFromEye(this.eye, cone);
    const view = evaluateView(this.layout, v, { easing: opts.easing });
    const schedule = renderSchedule(view, this.scenes.length, opts.scheduling);

    // 3. head-coupled camera shared by every scene
    const lim = this.eyeLimits;
    const camEye = {
      x: clamp(this.eye.x * opts.parallax, -lim.x, lim.x),
      y: clamp(this.eye.y * opts.parallax, -lim.y, lim.y),
      z: Math.max(this.eye.z, lim.minZ),
    };
    updateOffAxisCamera(this.camera, camEye, this.display.widthCm, this.display.heightCm);

    // 4. render only what can be seen
    const t0 = performance.now();
    const r = this.renderer;
    let scenePasses = 0;
    if (!schedule.composite) {
      // at rest: one scene straight to the canvas, no compositor
      r.setRenderTarget(null);
      r.render(this.scenes[view.from].scene, this.camera);
      scenePasses = 1;
    } else {
      let texA;
      let texB;
      if (opts.scheduling === "always") {
        for (const k of schedule.scenes) {
          r.setRenderTarget(this._target(k));
          r.render(this.scenes[k].scene, this.camera);
          scenePasses += 1;
        }
        texA = this._target(view.from).texture;
        texB = this._target(view.to).texture;
      } else {
        r.setRenderTarget(this._target(0));
        r.render(this.scenes[view.from].scene, this.camera);
        r.setRenderTarget(this._target(1));
        r.render(this.scenes[view.to].scene, this.camera);
        scenePasses = 2;
        texA = this._target(0).texture;
        texB = this._target(1).texture;
      }
      this.compositor.render(r, texA, texB, view.progress, null);
    }
    if (opts.syncTimings) {
      const gl = r.getContext();
      this._px = this._px || new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this._px); // blocks until the frame is done
    }
    const frameMs = performance.now() - t0;

    this.frame += 1;
    const stats = {
      frame: this.frame,
      v: view.v,
      zone: view.zone,
      from: view.from,
      to: view.to,
      scene: view.scene,
      progress: view.progress,
      eased: view.eased,
      prismAngleDeg: view.prismAngle / DEG,
      stepAngleDeg: (view.eased * 360) / this.layout.faceCount,
      active: view.active,
      scenePasses,
      composite: schedule.composite,
      frameMs,
      tracking: pose.tracking,
      source: this.tracker?.source ?? "none",
      eye: { ...this.eye },
      labels: this.scenes.map((s) => s.label),
    };
    this.lastStats = stats;
    this.onFrame?.(stats);
    return stats;
  }
}
