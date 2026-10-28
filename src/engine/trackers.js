/**
 * Head trackers. Each one reports where the viewer is; the engine turns that
 * into a view position v (which scene) and an eye position (parallax).
 *
 * getPose() returns one of:
 *   { eye: {x, y, z}, tracking }   — a real head position in cm, relative to
 *                                     the webcam, +x to the viewer's right,
 *                                     +y up, +z out of the screen
 *   { v, vy, tracking }            — a normalised position across the
 *                                     screen (0..1, left→right / top→bottom)
 */

/**
 * Eye position (cm, relative to the webcam) from a MindAR face estimate.
 *
 * MindAR builds `faceMatrix` ROW-major — [R00 R01 R02 tx, -R10 -R11 -R12 -ty,
 * -R20 -R21 -R22 -tz, 0 0 0 1] — and MindARThree applies it with
 * Matrix4.set(...m). The translation is therefore m[3], m[7], m[11]; the face
 * sits in front of the camera at negative z.
 */
export function eyeFromFaceMatrix(m) {
  return { x: m[3], y: m[7], z: -m[11] };
}

/**
 * MindAR face tracking — the pARelax methodology, minus MindARThree's own
 * renderer: we only need the pose. Runs the same sequence MindARThree's
 * start() does (video → controller.setup → dummyRun → processVideo).
 *
 * MindAR hands back `faceMatrix` as a ROW-major 4×4 array (MindARThree
 * applies it with Matrix4.set(...m)); the translation is m[3], m[7], m[11]
 * in cm with the face in front of the camera at negative z. Reading it
 * with Matrix4.fromArray (column-major) picks up m[12..14] = 0 instead and
 * the head position never reaches the camera.
 */
export class FaceTracker {
  constructor({ filterMinCF = null, filterBeta = null, mirror = true } = {}) {
    this.options = { filterMinCF, filterBeta };
    this.mirror = mirror;
    this.eye = null;
    this.tracking = false;
    this.lastSeen = 0;
    this.source = "face";
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera access is not available here (it needs HTTPS and a browser with getUserMedia).");
    }
    // ~2 MB of tracking code (MediaPipe + OpenCV); only fetched when face tracking starts
    const { Controller } = await import(
      /* webpackChunkName: "mindar-face" */ "mind-ar/dist/mindar-face.prod.js"
    );

    const video = document.createElement("video");
    video.setAttribute("autoplay", "");
    video.setAttribute("muted", "");
    video.setAttribute("playsinline", "");
    video.muted = true;
    Object.assign(video.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "2px",
      height: "2px",
      opacity: "0",
      pointerEvents: "none",
      zIndex: "-1",
    });
    document.body.appendChild(video);
    this.video = video;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user" },
    });
    await new Promise((resolve) => {
      video.addEventListener("loadedmetadata", resolve, { once: true });
      video.srcObject = this.stream;
    });
    await video.play().catch(() => {});
    // MindAR sizes its processing canvas and camera model from these attributes
    video.width = video.videoWidth;
    video.height = video.videoHeight;

    const controller = new Controller(this.options);
    controller.onUpdate = ({ hasFace, estimateResult }) => {
      if (hasFace && estimateResult?.faceMatrix?.length >= 16) {
        this.eye = eyeFromFaceMatrix(estimateResult.faceMatrix);
        this.tracking = true;
        this.lastSeen = performance.now();
      } else {
        this.tracking = false;
      }
    };
    controller.onInputResized(video);
    await controller.setup(this.mirror);
    await controller.dummyRun(video);
    controller.onInputResized(video);
    controller.processVideo(video);
    this.controller = controller;
    return this;
  }

  getPose() {
    return this.eye ? { eye: this.eye, tracking: this.tracking } : { v: 0.5, vy: 0.5, tracking: false };
  }

  stop() {
    this.controller?.stopProcessVideo();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video?.remove();
    this.controller = null;
    this.stream = null;
    this.video = null;
  }
}

/** Mouse / touch / pen: the pointer's x across the screen is v directly. */
export class PointerTracker {
  constructor({ target = window } = {}) {
    this.target = target;
    this.v = 0.5;
    this.vy = 0.5;
    this.source = "pointer";
    this._onMove = (e) => {
      const w = window.innerWidth || 1;
      const h = window.innerHeight || 1;
      this.v = Math.min(1, Math.max(0, e.clientX / w));
      this.vy = Math.min(1, Math.max(0, e.clientY / h));
    };
  }

  start() {
    this.target.addEventListener("pointermove", this._onMove, { passive: true });
    this.target.addEventListener("pointerdown", this._onMove, { passive: true });
    return this;
  }

  /** Nudge from the keyboard etc. */
  set(v, vy = this.vy) {
    this.v = Math.min(1, Math.max(0, v));
    this.vy = Math.min(1, Math.max(0, vy));
  }

  getPose() {
    return { v: this.v, vy: this.vy, tracking: true };
  }

  stop() {
    this.target.removeEventListener("pointermove", this._onMove);
    this.target.removeEventListener("pointerdown", this._onMove);
  }
}

/** Set the view position from code — used by the results harness and tests. */
export class ManualTracker {
  constructor(v = 0.5, vy = 0.5) {
    this.v = v;
    this.vy = vy;
    this.source = "manual";
  }
  start() {
    return this;
  }
  set(v, vy = this.vy) {
    this.v = v;
    this.vy = vy;
  }
  getPose() {
    return { v: this.v, vy: this.vy, tracking: true };
  }
  stop() {}
}

export function createTracker(kind, options = {}) {
  if (kind && typeof kind === "object" && typeof kind.getPose === "function") return kind;
  switch (kind) {
    case "face":
      return new FaceTracker(options.face);
    case "manual":
      return new ManualTracker(options.v, options.vy);
    case "pointer":
    default:
      return new PointerTracker(options.pointer);
  }
}
