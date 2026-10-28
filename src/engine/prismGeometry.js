/**
 * Rotating-prism mask geometry — CPU reference for the GLSL compositor.
 *
 * The screen is covered by `count` vertical prisms, one per strip of width
 * `pitch` (= screen width / count). Each prism is a regular K-gon in cross
 * section whose face width equals the pitch, so at rest the front faces tile
 * the screen with no gaps or overlaps. Face f carries scene f.
 *
 * Cross-section coordinates are in units of the pitch:
 *   s ∈ [-0.5, 0.5]  horizontal offset of a pixel from its prism's axis
 *   z                towards the viewer
 * The view is orthographic along -z: the prisms sit on the screen plane like
 * a lenticular sheet laminated onto the display.
 *
 * Face f's outward normal at rotation θ has angle
 *     ψ_f = dir · (f·α − θ),   α = 2π / K
 * measured from +z towards +x. θ = f·α brings face f front-on. With dir = +1
 * the incoming face swings in from the right while the outgoing one turns
 * away to the left — the prism "shows you its right side" as you move right.
 *
 * Within a face, u ∈ [-0.5, 0.5] runs left→right as seen when that face is
 * front-on, so u is also the position inside the strip the face carries.
 *
 * The GLSL in prismComposite.js mirrors castRay / shadeFace line for line;
 * the Jest suite pins this file down, and the results harness checks the GPU
 * output against it.
 */

import { TAU } from "./viewZones";

/** Apothem (axis-to-face distance) of a regular K-gon with unit face width. */
export function apothem(faceCount) {
  return 1 / (2 * Math.tan(Math.PI / faceCount));
}

/** Circumradius (axis-to-edge distance) of a regular K-gon with unit face width. */
export function circumradius(faceCount) {
  return 1 / (2 * Math.sin(Math.PI / faceCount));
}

/** Outward normal (x, z) of face f at rotation theta. */
export function faceNormal(f, theta, faceCount, dir = 1) {
  const psi = dir * (f * (TAU / faceCount) - theta);
  return { x: Math.sin(psi), z: Math.cos(psi), psi };
}

/**
 * Cast the orthographic view ray through offset s and find the front-most face.
 *
 * @param {number}   s           offset across the prism, -0.5..0.5 (pitch units)
 * @param {number}   theta       prism rotation, radians
 * @param {number}   faceCount   K
 * @param {number}   [dir=1]     rotation direction (+1 / -1)
 * @param {number[]} [faces]     faces to test; defaults to all K
 * @returns {{face:number, u:number, z:number, normal:{x:number,z:number}} | null}
 *          null when the ray passes through a gap between prisms
 */
export function castRay(s, theta, faceCount, dir = 1, faces) {
  const a = apothem(faceCount);
  const list = faces ?? Array.from({ length: faceCount }, (_, f) => f);
  let best = null;
  for (const f of list) {
    const n = faceNormal(f, theta, faceCount, dir);
    if (n.z <= 1e-4) continue; // back-facing or edge-on
    const z = (a - n.x * s) / n.z; // intersection with the face's plane
    const u = s * n.z - z * n.x; // position along the face (tangent = (cos ψ, -sin ψ))
    if (Math.abs(u) <= 0.5 + 1e-9 && (best === null || z > best.z)) {
      best = { face: f, u, z, normal: { x: n.x, z: n.z } };
    }
  }
  return best;
}

/**
 * Cast through screen position x (pitch units, 0..count) against the pixel's
 * own prism *and its two neighbours*. A turning prism's corners overhang its
 * own strip by up to (circumradius − ½) — 0.077 pitch for a triangle — and
 * square or wider prisms can occlude their neighbours, so testing only the
 * pixel's own prism would misplace the gaps. The front-most hit wins.
 *
 * @param {number}   x          screen position in pitch units
 * @param {number}   count      number of prisms across the screen
 * @param {(j:number)=>number} thetaOf  rotation of prism j (stagger makes it vary)
 * @returns {{prism:number, face:number, u:number, z:number, normal:{x:number,z:number}} | null}
 */
export function castScreen(x, count, thetaOf, faceCount, dir = 1, faces) {
  const i = Math.floor(x);
  let best = null;
  for (let j = i - 1; j <= i + 1; j++) {
    if (j < 0 || j >= count) continue;
    const hit = castRay(x - (j + 0.5), thetaOf(j), faceCount, dir, faces);
    if (hit && (best === null || hit.z > best.z)) best = { ...hit, prism: j };
  }
  return best;
}

/**
 * Silhouette width of a prism (pitch units) — 1 when a face is front-on,
 * dipping to cos(π/K) half-way between (0.866 for a triangle). The shortfall
 * is the gap you see between real tri-vision slats while they turn.
 */
export function silhouetteWidth(theta, faceCount) {
  const R = circumradius(faceCount);
  let lo = Infinity;
  let hi = -Infinity;
  for (let j = 0; j < faceCount; j++) {
    // vertices sit half-way between face normals
    const phi = ((j + 0.5) * TAU) / faceCount - theta;
    const x = R * Math.sin(phi);
    lo = Math.min(lo, x);
    hi = Math.max(hi, x);
  }
  return hi - lo;
}

/**
 * Fraction of one strip of the screen covered by each face (and by the gap)
 * when every prism sits at rotation theta, measured by casting `samples`
 * rays across a strip in the middle of a row — the same thing the shader
 * does per pixel, neighbours' overhangs included.
 */
export function faceCoverage(theta, faceCount, dir = 1, samples = 2000) {
  const cover = new Array(faceCount).fill(0);
  let gap = 0;
  for (let k = 0; k < samples; k++) {
    const x = 1 + (k + 0.5) / samples; // strip 1 of a 3-prism row
    const hit = castScreen(x, 3, () => theta, faceCount, dir);
    if (hit) cover[hit.face] += 1;
    else gap += 1;
  }
  return { faces: cover.map((c) => c / samples), gap: gap / samples };
}

/**
 * Where a face samples its scene, in screen x (pixels), for a pixel at
 * screen x `sx` inside prism `i` hit at face position `u`.
 *   mapping 0 = "print": the face carries its strip, so turning it
 *               foreshortens the picture (a tri-vision billboard)
 *   mapping 1 = "mask":  the face is an aperture onto a screen-locked scene
 * Values in between blend the two.
 */
export function sampleX(sx, i, u, pitch, mapping = 0) {
  const printX = (i + 0.5 + u) * pitch;
  return printX + (sx - printX) * mapping;
}

/**
 * Relative face shading. Exactly 1 for a front-on face, so a prism at rest
 * reproduces the scene pixel-for-pixel and the hand-off between the direct
 * (1-scene) path and the compositor (2-scene) path is invisible.
 *
 * @param {{x:number,z:number}} normal  face normal (x, z); y is 0 for vertical prisms
 * @param {number[]} light               normalised light direction [x, y, z]
 * @param {number}   strength            0 = flat, 1 = full Lambert ratio
 */
export function shadeFace(normal, light, strength = 1) {
  const lambert = Math.max(normal.x * light[0] + normal.z * light[2], 0) / Math.max(light[2], 1e-3);
  return 1 + (lambert - 1) * strength;
}
