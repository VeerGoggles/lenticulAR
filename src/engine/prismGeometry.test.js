/**
 * @jest-environment node
 */
import {
  apothem,
  circumradius,
  castRay,
  castScreen,
  silhouetteWidth,
  faceCoverage,
  sampleX,
  shadeFace,
  faceNormal,
} from "./prismGeometry";

const rad = (d) => (d * Math.PI) / 180;
const LIGHT = (() => {
  const l = [-0.55, 0.35, 0.76];
  const n = Math.hypot(...l);
  return l.map((c) => c / n);
})();

describe("regular prism cross-section", () => {
  test("triangle with unit faces", () => {
    expect(apothem(3)).toBeCloseTo(1 / (2 * Math.sqrt(3)), 12);
    expect(circumradius(3)).toBeCloseTo(1 / Math.sqrt(3), 12);
  });

  test("silhouette is a full pitch at rest and dips to cos(π/K) half-way", () => {
    expect(silhouetteWidth(0, 3)).toBeCloseTo(1, 12);
    expect(silhouetteWidth(rad(60), 3)).toBeCloseTo(1, 12);
    expect(silhouetteWidth(rad(30), 3)).toBeCloseTo(Math.sqrt(3) / 2, 12);
    expect(silhouetteWidth(rad(45), 4)).toBeCloseTo(Math.SQRT2, 12); // a square seen corner-on is wider
  });
});

describe("castRay — what each pixel of a prism shows", () => {
  test("at rest the front face covers the strip with an identity mapping", () => {
    for (let i = 0; i <= 100; i++) {
      const s = i / 100 - 0.5;
      const hit = castRay(s, 0, 3);
      expect(hit.face).toBe(0);
      expect(hit.u).toBeCloseTo(s, 12);
      expect(hit.normal.z).toBeCloseTo(1, 12);
    }
  });

  test("after one step (120°) the next face does the same", () => {
    for (let i = 0; i <= 100; i++) {
      const s = i / 100 - 0.5;
      const hit = castRay(s, rad(120), 3);
      expect(hit.face).toBe(1);
      expect(hit.u).toBeCloseTo(s, 9);
    }
  });

  test("half-way (60°) each face shows its whole strip squeezed into half the pitch", () => {
    const left = castRay(-0.25, rad(60), 3);
    const right = castRay(0.25, rad(60), 3);
    // dir = +1: the outgoing face turns away to the left, the incoming one arrives from the right
    expect(left.face).toBe(0);
    expect(right.face).toBe(1);
    // the outgoing face's strip spans the left half end-to-end
    expect(castRay(-0.4999999, rad(60), 3).u).toBeCloseTo(-0.5, 5);
    expect(castRay(-1e-7, rad(60), 3).u).toBeCloseTo(0.5, 5);
    expect(castRay(1e-7, rad(60), 3).u).toBeCloseTo(-0.5, 5);
    expect(castRay(0.4999999, rad(60), 3).u).toBeCloseTo(0.5, 5);
  });

  test("dir = -1 mirrors the rotation", () => {
    expect(castRay(-0.25, rad(60), 3, -1).face).toBe(1);
    expect(castRay(0.25, rad(60), 3, -1).face).toBe(0);
  });

  test("a turning prism's silhouette shifts off-centre and overhangs its strip", () => {
    // at 30° the outgoing face spans x ∈ [-R, R/2] = [-0.577, 0.289]
    const R = circumradius(3);
    expect(castRay(-R + 1e-6, rad(30), 3)).not.toBeNull(); // overhangs the left neighbour's strip
    expect(castRay(-R - 1e-3, rad(30), 3)).toBeNull();
    expect(castRay(R / 2 - 1e-6, rad(30), 3)).not.toBeNull();
    expect(castRay(R / 2 + 1e-3, rad(30), 3)).toBeNull();
  });

  test("castScreen picks up the neighbour's overhang, leaving a 1 - cos 30° gap", () => {
    const R = circumradius(3);
    const at = (x) => castScreen(x, 3, () => rad(30), 3);
    // inside strip 1 (x ∈ [1, 2]); prism 1 covers [1.5 - R, 1.5 + R/2]
    expect(at(1.5 + R / 2 - 1e-6).prism).toBe(1);
    expect(at(1.5 + R / 2 + 1e-3)).toBeNull(); // gap
    expect(at(2.5 - R + 1e-6).prism).toBe(2); // right neighbour reaching into strip 1
    expect(2.5 - R).toBeLessThan(2);
    expect(2.5 - R - (1.5 + R / 2)).toBeCloseTo(1 - Math.sqrt(3) / 2, 12);
  });

  test("per-prism rotations (stagger) are honoured and the front-most hit wins", () => {
    // turned square prisms are up to √2 wide, so neighbours overlap and occlude each other
    const thetaOf = (j) => (j === 0 ? rad(45) : j === 1 ? rad(30) : 0);
    expect(castScreen(0.9, 3, thetaOf, 4).prism).toBe(0);
    // still inside strip 0, but prism 1's face is nearer the viewer here
    expect(castScreen(0.98, 3, thetaOf, 4).prism).toBe(1);
    expect(castScreen(0.98, 3, () => 0, 4).prism).toBe(0);
  });

  test("only the outgoing and incoming faces are ever visible during a step", () => {
    for (let a = 0; a <= 120; a += 0.5) {
      for (let i = 0; i <= 50; i++) {
        const hit = castRay(i / 50 - 0.5, rad(a), 3);
        if (hit) expect([0, 1]).toContain(hit.face);
      }
    }
  });

  test("restricting the candidate faces to the two active ones changes nothing", () => {
    for (let a = 0; a <= 120; a += 3) {
      for (let i = 0; i <= 40; i++) {
        const s = i / 40 - 0.5;
        const all = castRay(s, rad(a), 3);
        const two = castRay(s, rad(a), 3, 1, [0, 1]);
        expect(two?.face ?? null).toBe(all?.face ?? null);
        if (all) expect(two.u).toBeCloseTo(all.u, 12);
      }
    }
  });
});

describe("faceCoverage", () => {
  test("covers the whole strip at rest, no gaps", () => {
    const c = faceCoverage(0, 3);
    expect(c.faces[0]).toBeCloseTo(1, 6);
    expect(c.gap).toBe(0);
  });

  test("50/50 split half-way through the turn", () => {
    const c = faceCoverage(rad(60), 3);
    expect(c.faces[0]).toBeCloseTo(0.5, 3);
    expect(c.faces[1]).toBeCloseTo(0.5, 3);
    expect(c.gap).toBeCloseTo(0, 3);
  });

  test("13.4% of the strip is gap at 30° (1 - cos 30°)", () => {
    const c = faceCoverage(rad(30), 3);
    expect(c.gap).toBeCloseTo(1 - Math.sqrt(3) / 2, 2);
    expect(c.faces[0]).toBeCloseTo(Math.sqrt(3) / 2, 2); // the incoming face is still edge-on
  });

  test("visible width of each face is pitch · cos(ψ)", () => {
    for (const a of [10, 25, 40, 75, 100]) {
      const c = faceCoverage(rad(a), 3);
      const n0 = faceNormal(0, rad(a), 3);
      const n1 = faceNormal(1, rad(a), 3);
      expect(c.faces[0]).toBeCloseTo(Math.max(0, n0.z), 2);
      expect(c.faces[1]).toBeCloseTo(Math.max(0, n1.z), 2);
    }
  });
});

describe("sampleX", () => {
  test("print and mask mappings agree at rest", () => {
    const pitch = 40;
    for (const sx of [3, 17.5, 39]) {
      const s = sx / pitch - 0.5;
      const hit = castRay(s, 0, 3);
      expect(sampleX(sx, 0, hit.u, pitch, 0)).toBeCloseTo(sx, 9);
      expect(sampleX(sx, 0, hit.u, pitch, 1)).toBeCloseTo(sx, 9);
    }
  });

  test("print mapping squeezes the strip onto a turned face", () => {
    const pitch = 40;
    // half-way: the left half (0..20 px) shows the outgoing face's full 0..40 px strip
    const at = (sx) => sampleX(sx, 0, castRay(sx / pitch - 0.5, rad(60), 3).u, pitch, 0);
    expect(at(0.001)).toBeCloseTo(0, 1);
    expect(at(10)).toBeCloseTo(20, 6);
    expect(at(19.999)).toBeCloseTo(40, 1);
  });
});

describe("shadeFace", () => {
  test("exactly 1 for a front-on face, whatever the strength", () => {
    for (const k of [0, 0.5, 1]) expect(shadeFace({ x: 0, z: 1 }, LIGHT, k)).toBeCloseTo(1, 12);
  });

  test("faces turned towards the light brighten, away from it darken", () => {
    const toward = faceNormal(0, rad(30), 3); // turned left, light comes from the left
    const away = faceNormal(1, rad(60), 3); // turned right
    expect(shadeFace(toward, LIGHT, 1)).toBeGreaterThan(1);
    expect(shadeFace(away, LIGHT, 1)).toBeLessThan(1);
  });
});
