import * as THREE from "three";
import { apothem, circumradius } from "./prismGeometry";
import { EASINGS, EASING_IDS, TAU } from "./viewZones";

/**
 * Full-screen pass that composites two scene render targets through a row
 * of rotating prisms. Per pixel it casts an orthographic ray against the
 * pixel's own prism and both neighbours (turning prisms overhang their
 * strips), finds the front-most face, and samples the scene that face
 * carries. This is prismGeometry.js in GLSL — keep the two in step.
 *
 * At rest (progress 0 or 1) the output is the outgoing / incoming scene
 * pixel-for-pixel: front-on faces get a shading factor of exactly 1, the
 * glint and crease terms are scaled by sin(π·progress), and the texture is
 * read at the pixel centre. That is what lets the engine skip this pass
 * entirely outside the transition bands without a visible seam.
 */

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D tA;        // outgoing scene (face 0)
uniform sampler2D tB;        // incoming scene (face 1)
uniform vec2  uResolution;   // drawing-buffer size, px
uniform float uPrismCount;   // prisms across the width
uniform float uAlpha;        // 2π / faces — one face step
uniform float uApothem;      // axis-to-face distance for unit-width faces
uniform float uCircum;       // axis-to-edge distance: nothing of a prism reaches further
uniform float uProgress;     // linear progress through the transition band, 0..1
uniform float uStagger;      // 0 = lockstep; >0 sweeps left→right, <0 right→left
uniform int   uEasing;       // 0 linear, 1 smoothstep, 2 smootherstep
uniform float uDir;          // rotation direction, ±1
uniform float uMapping;      // 0 = print (faces carry their strip), 1 = mask (screen-locked)
uniform float uShading;      // Lambert strength
uniform float uSpecular;     // glint strength
uniform float uShininess;
uniform float uCrease;       // darkening into the crease between faces while turning
uniform vec3  uLight;        // normalised light direction (display space)
uniform vec3  uGapColor;     // the backing seen between turning prisms (linear)
uniform float uGapFill;      // 0 = solid backing; >0 lets a dimmed scene show through the gaps
uniform int   uSamples;      // horizontal supersamples per pixel (1..4)
uniform int   uDebug;        // 1 = flat face ids: A red, B green, gap black
// per-frame values computed once on the CPU (see render())
uniform float uEased;        // eased progress
uniform float uTheta;        // lockstep prism rotation
uniform vec2  uNA;           // lockstep normal of the outgoing face (x, z)
uniform vec2  uNB;           // lockstep normal of the incoming face
uniform float uTurning;      // sin(pi * eased): 0 at rest, 1 half-way
uniform vec3  uHalf;         // Blinn half vector of the light and the view direction
uniform float uSpecRest;     // glint of a front-on face, subtracted so rest stays neutral

varying vec2 vUv;

const float PI = 3.141592653589793;

float easeFn(float t) {
  if (uEasing == 1) return t * t * (3.0 - 2.0 * t);
  if (uEasing == 2) return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  return t;
}

// Face normals (outgoing A, incoming B) of prism j. In lockstep every prism
// shares them, so they come in as uniforms; a staggered flip needs them per prism.
void prismFaces(float j, out vec2 nA, out vec2 nB, out float theta) {
  if (uStagger == 0.0) {
    nA = uNA; nB = uNB; theta = uTheta;
    return;
  }
  float xhat = (j + 0.5) / uPrismCount;
  float k = abs(uStagger);
  float xs = uStagger > 0.0 ? xhat : 1.0 - xhat;
  theta = easeFn(clamp(uProgress * (1.0 + k) - k * xs, 0.0, 1.0)) * uAlpha;
  float psiA = -uDir * theta;             // face 0: psi = dir * (0 * alpha - theta)
  float psiB = uDir * (uAlpha - theta);   // face 1: psi = dir * (1 * alpha - theta)
  nA = vec2(sin(psiA), cos(psiA));
  nB = vec2(sin(psiB), cos(psiB));
}

// Orthographic ray at offset s (pitch units) against one face; keeps the front-most hit.
void testFace(float s, vec2 n, float faceId, float j, float theta,
              inout float bestZ, inout float bestFace, inout float bestU,
              inout vec2 bestN, inout float bestJ, inout float bestTheta) {
  if (n.y <= 1e-4) return;                  // back-facing / edge-on
  float z = (uApothem - n.x * s) / n.y;     // plane intersection
  float u = s * n.y - z * n.x;              // position along the face
  if (abs(u) <= 0.5 + 1e-5 && z > bestZ) {
    bestZ = z; bestFace = faceId; bestU = u; bestN = n; bestJ = j; bestTheta = theta;
  }
}

void main() {
  float pitch = uResolution.x / uPrismCount;
  float ns = float(uSamples);
  vec3 acc = vec3(0.0);

  for (int k = 0; k < 4; k++) {
    if (k >= uSamples) break;
    float sx = gl_FragCoord.x + (float(k) + 0.5) / ns - 0.5;   // subsample x, px
    float x = sx / pitch;                                      // pitch units
    float i = floor(x);

    // the pixel's own prism and both neighbours (turning prisms overhang their strips)
    float bestZ = -1e9, bestFace = -1.0, bestU = 0.0, bestJ = i, bestTheta = 0.0;
    vec2 bestN = vec2(0.0, 1.0);
    for (int d = -1; d <= 1; d++) {
      float j = i + float(d);
      if (j < 0.0 || j > uPrismCount - 1.0) continue;
      float s = x - (j + 0.5);
      if (abs(s) > uCircum + 1e-4) continue;  // out of this neighbour's reach (most pixels)
      vec2 nA, nB; float th;
      prismFaces(j, nA, nB, th);
      testFace(s, nA, 0.0, j, th, bestZ, bestFace, bestU, bestN, bestJ, bestTheta);
      testFace(s, nB, 1.0, j, th, bestZ, bestFace, bestU, bestN, bestJ, bestTheta);
    }

    vec3 col;
    if (bestFace < 0.0) {
      // a shadowed crevice: the backing, with a little of the scene showing through
      vec2 uvp = vec2(sx, gl_FragCoord.y) / uResolution;
      vec3 behind = mix(texture2D(tA, uvp).rgb, texture2D(tB, uvp).rgb, uEased);
      col = mix(uGapColor, behind, uGapFill);
    } else {
      // where this face samples its scene: its own strip (print) or the pixel itself (mask)
      float printX = (bestJ + 0.5 + bestU) * pitch;
      float mapX = mix(printX, sx, uMapping);
      // apply the mapping as an offset from the pixel centre so rest is an exact identity
      vec2 uv = vec2(gl_FragCoord.x + (mapX - sx), gl_FragCoord.y) / uResolution;
      vec3 albedo = bestFace < 0.5 ? texture2D(tA, uv).rgb : texture2D(tB, uv).rgb;

      vec3 N = vec3(bestN.x, 0.0, bestN.y);
      float lambert = max(dot(N, uLight), 0.0) / max(uLight.z, 1e-3);
      float shade = 1.0 + (lambert - 1.0) * uShading;
      float turning = uStagger == 0.0 ? uTurning : sin(PI * clamp(bestTheta / uAlpha, 0.0, 1.0));
      float crease = 1.0 - uCrease * turning * smoothstep(0.3, 0.5, abs(bestU));
      float spec = max(pow(max(dot(N, uHalf), 0.0), uShininess) - uSpecRest, 0.0);
      col = albedo * shade * crease + vec3(spec * uSpecular * turning);
    }
    if (uDebug == 1) {
      col = bestFace < 0.0 ? vec3(0.0) : (bestFace < 0.5 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0));
    }
    acc += col;
  }

  gl_FragColor = vec4(acc / ns, 1.0);
  #include <colorspace_fragment>
}
`;

export const DEFAULT_PRISM_OPTIONS = {
  count: 24, // prisms across the screen
  mapping: "print", // "print" | "mask" | 0..1 blend
  direction: 1, // +1: the incoming face swings in from the side the viewer moves towards
  stagger: 0, // 0 = all prisms turn in lockstep
  shading: 0.45,
  specular: 0.15,
  shininess: 90,
  crease: 0.35,
  light: [-0.42, 0.25, 0.87],
  gapColor: "#07060d",
  gapFill: 0.3,
  samples: 4,
  debugFaces: false,
};

export function mappingValue(mapping) {
  if (mapping === "print") return 0;
  if (mapping === "mask") return 1;
  const m = Number(mapping);
  return Number.isFinite(m) ? Math.min(1, Math.max(0, m)) : 0;
}

export default class PrismCompositor {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        tA: { value: null },
        tB: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPrismCount: { value: DEFAULT_PRISM_OPTIONS.count },
        uAlpha: { value: TAU / 3 },
        uApothem: { value: apothem(3) },
        uCircum: { value: circumradius(3) },
        uProgress: { value: 0 },
        uStagger: { value: 0 },
        uEasing: { value: EASING_IDS.smoothstep },
        uDir: { value: 1 },
        uMapping: { value: 0 },
        uShading: { value: DEFAULT_PRISM_OPTIONS.shading },
        uSpecular: { value: DEFAULT_PRISM_OPTIONS.specular },
        uShininess: { value: DEFAULT_PRISM_OPTIONS.shininess },
        uCrease: { value: DEFAULT_PRISM_OPTIONS.crease },
        uLight: { value: new THREE.Vector3().fromArray(DEFAULT_PRISM_OPTIONS.light).normalize() },
        uGapColor: { value: new THREE.Color(DEFAULT_PRISM_OPTIONS.gapColor) },
        uGapFill: { value: DEFAULT_PRISM_OPTIONS.gapFill },
        uSamples: { value: DEFAULT_PRISM_OPTIONS.samples },
        uDebug: { value: 0 },
        uEased: { value: 0 },
        uTheta: { value: 0 },
        uNA: { value: new THREE.Vector2(0, 1) },
        uNB: { value: new THREE.Vector2(0, 1) },
        uTurning: { value: 0 },
        uHalf: { value: new THREE.Vector3(0, 0, 1) },
        uSpecRest: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.ease = EASINGS.smoothstep;
  }

  /** Apply prism options (any subset of DEFAULT_PRISM_OPTIONS) and the face count. */
  configure(prism, faceCount, easing) {
    const u = this.material.uniforms;
    u.uPrismCount.value = Math.max(1, Math.round(prism.count));
    u.uAlpha.value = TAU / faceCount;
    u.uApothem.value = apothem(faceCount);
    u.uCircum.value = circumradius(faceCount);
    u.uStagger.value = prism.stagger;
    u.uEasing.value = EASING_IDS[easing] ?? 1;
    u.uDir.value = prism.direction >= 0 ? 1 : -1;
    u.uMapping.value = mappingValue(prism.mapping);
    u.uShading.value = prism.shading;
    u.uSpecular.value = prism.specular;
    u.uShininess.value = prism.shininess;
    u.uCrease.value = prism.crease;
    u.uLight.value.fromArray(prism.light).normalize();
    u.uGapColor.value.set(prism.gapColor);
    u.uGapFill.value = prism.gapFill;
    u.uSamples.value = Math.min(4, Math.max(1, Math.round(prism.samples)));
    u.uDebug.value = prism.debugFaces ? 1 : 0;
    this.ease = EASINGS[easing] ?? EASINGS.smoothstep;
    // Blinn half vector of the light and the view direction (0, 0, 1), and the
    // glint a front-on face would get, so the specular term is exactly 0 at rest
    const l = u.uLight.value;
    u.uHalf.value.set(l.x, l.y, l.z + 1).normalize();
    u.uSpecRest.value = Math.pow(Math.max(u.uHalf.value.z, 0), prism.shininess);
  }

  setSize(width, height) {
    this.material.uniforms.uResolution.value.set(width, height);
  }

  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Texture} texA     outgoing scene
   * @param {THREE.Texture} texB     incoming scene
   * @param {number} progress        linear band progress, 0..1
   * @param {THREE.WebGLRenderTarget|null} target  null = the canvas
   */
  render(renderer, texA, texB, progress, target = null) {
    const u = this.material.uniforms;
    u.tA.value = texA;
    u.tB.value = texB;
    u.uProgress.value = progress;
    // lockstep values, shared by every prism (see prismFaces in the shader)
    const eased = this.ease(Math.min(1, Math.max(0, progress)));
    const alpha = u.uAlpha.value;
    const dir = u.uDir.value;
    const theta = eased * alpha;
    const psiA = -dir * theta;
    const psiB = dir * (alpha - theta);
    u.uEased.value = eased;
    u.uTheta.value = theta;
    u.uNA.value.set(Math.sin(psiA), Math.cos(psiA));
    u.uNB.value.set(Math.sin(psiB), Math.cos(psiB));
    u.uTurning.value = Math.sin(Math.PI * eased);
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.scene.traverse((o) => o.geometry?.dispose());
    this.material.dispose();
  }
}
