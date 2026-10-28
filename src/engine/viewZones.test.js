/**
 * @jest-environment node
 */
import {
  createViewLayout,
  evaluateView,
  prismProgress,
  renderSchedule,
  viewFromEye,
  eyeXFromView,
  EASINGS,
  faceCountFor,
} from "./viewZones";

const deg = (r) => (r * 180) / Math.PI;

describe("createViewLayout", () => {
  test("three scenes default to boundaries at 1/3 and 2/3 with ±5% bands", () => {
    const layout = createViewLayout();
    expect(layout.sceneCount).toBe(3);
    expect(layout.faceCount).toBe(3);
    expect(layout.boundaries[0]).toBeCloseTo(1 / 3, 12);
    expect(layout.boundaries[1]).toBeCloseTo(2 / 3, 12);
    expect(layout.bands[0].start).toBeCloseTo(1 / 3 - 0.05, 12);
    expect(layout.bands[0].end).toBeCloseTo(1 / 3 + 0.05, 12);
    expect(layout.bands[1].start).toBeCloseTo(2 / 3 - 0.05, 12);
    expect(layout.bands[1].end).toBeCloseTo(2 / 3 + 0.05, 12);
  });

  test("rejects overlapping or out-of-range bands", () => {
    expect(() => createViewLayout({ transitionHalfWidth: 0.2 })).toThrow(/overlap/);
    expect(() => createViewLayout({ sceneCount: 2, boundaries: [0.02] })).toThrow(/leaves/);
    expect(() => createViewLayout({ sceneCount: 1 })).toThrow(RangeError);
    expect(() => createViewLayout({ sceneCount: 3, boundaries: [0.5] })).toThrow(/expected 2/);
  });

  test("prisms get one face per scene, minimum three", () => {
    expect(faceCountFor(2)).toBe(3);
    expect(faceCountFor(3)).toBe(3);
    expect(faceCountFor(5)).toBe(5);
  });
});

describe("evaluateView — the 1-scene / 2-scene schedule", () => {
  const layout = createViewLayout();

  test.each([
    [0.0, 0],
    [0.1, 0],
    [0.2833, 0], // just before the A→B band
    [0.3834, 1], // just after it
    [0.5, 1],
    [0.6166, 1],
    [0.7167, 2],
    [1.0, 2],
  ])("v=%p rests on scene %p and renders exactly one scene", (v, scene) => {
    const view = evaluateView(layout, v);
    expect(view.zone).toBe("rest");
    expect(view.active).toEqual([scene]);
    expect(view.progress).toBe(0);
  });

  test.each([
    [0.29, 0, 1],
    [1 / 3, 0, 1],
    [0.38, 0, 1],
    [0.62, 1, 2],
    [2 / 3, 1, 2],
    [0.71, 1, 2],
  ])("v=%p is mid-transition and renders scenes %p and %p", (v, from, to) => {
    const view = evaluateView(layout, v);
    expect(view.zone).toBe("transition");
    expect(view.active).toEqual([from, to]);
  });

  test("band edges are rest states (open interval)", () => {
    const { start, end } = layout.bands[0];
    expect(evaluateView(layout, start).zone).toBe("rest");
    expect(evaluateView(layout, end).zone).toBe("rest");
    expect(evaluateView(layout, start + 1e-6).zone).toBe("transition");
    expect(evaluateView(layout, end - 1e-6).zone).toBe("transition");
  });

  test("never renders more than two scenes anywhere in the range", () => {
    for (let i = 0; i <= 10000; i++) {
      const view = evaluateView(layout, i / 10000);
      expect(view.active.length).toBeLessThanOrEqual(2);
      expect(renderSchedule(view, 3).scenes.length).toBe(view.active.length);
    }
  });

  test("prism angle is continuous and monotonic across the whole range", () => {
    let prev = -Infinity;
    for (let i = 0; i <= 2000; i++) {
      const view = evaluateView(layout, i / 2000);
      expect(view.prismAngle).toBeGreaterThanOrEqual(prev - 1e-12);
      if (i > 0) expect(view.prismAngle - prev).toBeLessThan(0.02); // no jumps
      prev = view.prismAngle;
    }
  });

  test("prisms turn 120° per transition on a triangular prism", () => {
    expect(deg(evaluateView(layout, 0.1).prismAngle)).toBeCloseTo(0, 9);
    expect(deg(evaluateView(layout, 1 / 3).prismAngle)).toBeCloseTo(60, 9);
    expect(deg(evaluateView(layout, 0.5).prismAngle)).toBeCloseTo(120, 9);
    expect(deg(evaluateView(layout, 2 / 3).prismAngle)).toBeCloseTo(180, 9);
    expect(deg(evaluateView(layout, 0.9).prismAngle)).toBeCloseTo(240, 9);
  });

  test("dominant scene switches at the boundary centre", () => {
    expect(evaluateView(layout, 1 / 3 - 0.001).scene).toBe(0);
    expect(evaluateView(layout, 1 / 3 + 0.001).scene).toBe(1);
  });

  test("clamps out-of-range and non-finite input", () => {
    expect(evaluateView(layout, -3).active).toEqual([0]);
    expect(evaluateView(layout, 7).active).toEqual([2]);
    expect(evaluateView(layout, NaN).active).toEqual([1]);
  });

  test("custom boundaries and widths", () => {
    const l = createViewLayout({ sceneCount: 4, boundaries: [0.2, 0.5, 0.8], transitionHalfWidth: 0.03 });
    expect(evaluateView(l, 0.5).active).toEqual([1, 2]);
    expect(evaluateView(l, 0.56).active).toEqual([2]);
    expect(evaluateView(l, 0.81).active).toEqual([2, 3]);
    expect(deg(evaluateView(l, 0.9).prismAngle)).toBeCloseTo(270, 9); // square prism, 90° steps
  });

  test("zero-width bands degrade to a hard switch with one scene everywhere", () => {
    const l = createViewLayout({ transitionHalfWidth: 0 });
    for (let i = 0; i <= 1000; i++) expect(evaluateView(l, i / 1000).active.length).toBe(1);
  });
});

describe("easing", () => {
  test.each(Object.keys(EASINGS))("%s maps 0→0, 1→1 and is monotonic", (name) => {
    const f = EASINGS[name];
    expect(f(0)).toBe(0);
    expect(f(1)).toBeCloseTo(1, 12);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      expect(f(i / 100)).toBeGreaterThanOrEqual(prev);
      prev = f(i / 100);
    }
  });
});

describe("prismProgress (stagger / sweep)", () => {
  test("no stagger keeps every prism in lockstep", () => {
    for (const x of [0, 0.3, 1]) expect(prismProgress(0.42, x, 0)).toBe(0.42);
  });

  test("every prism is at rest at the band start and finished at the band end", () => {
    for (const k of [0.25, 1, 3, -1]) {
      for (let i = 0; i <= 20; i++) {
        const x = i / 20;
        expect(prismProgress(0, x, k)).toBe(0);
        expect(prismProgress(1, x, k)).toBe(1);
      }
    }
  });

  test("positive stagger sweeps left to right, negative right to left", () => {
    expect(prismProgress(0.3, 0.1, 1)).toBeGreaterThan(prismProgress(0.3, 0.9, 1));
    expect(prismProgress(0.3, 0.1, -1)).toBeLessThan(prismProgress(0.3, 0.9, -1));
  });
});

describe("eye ↔ view mapping", () => {
  const cone = (40 * Math.PI) / 180;

  test("centre of the screen maps to v = 0.5", () => {
    expect(viewFromEye({ x: 0, y: 0, z: 50 }, cone)).toBeCloseTo(0.5, 12);
  });

  test("v depends on viewing angle, not distance", () => {
    const near = viewFromEye({ x: 5, y: 0, z: 40 }, cone);
    const far = viewFromEye({ x: 10, y: 0, z: 80 }, cone);
    expect(near).toBeCloseTo(far, 12);
  });

  test("viewer's right is +v", () => {
    expect(viewFromEye({ x: 8, y: 0, z: 50 }, cone)).toBeGreaterThan(0.5);
  });

  test("round trip", () => {
    for (const v of [0.1, 1 / 3, 0.5, 0.77]) {
      const x = eyeXFromView(v, 55, cone);
      expect(viewFromEye({ x, y: 0, z: 55 }, cone)).toBeCloseTo(v, 12);
    }
  });

  test("1/3 of the way across sits about 6.7° left of centre with a 40° cone", () => {
    const x = eyeXFromView(1 / 3, 50, cone);
    expect(deg(Math.atan2(x, 50))).toBeCloseTo(-40 / 6, 9);
  });
});

describe("renderSchedule", () => {
  const layout = createViewLayout();
  test("lazy: direct path at rest, compositor only in transitions", () => {
    expect(renderSchedule(evaluateView(layout, 0.1), 3)).toEqual({ scenes: [0], composite: false });
    expect(renderSchedule(evaluateView(layout, 0.33), 3)).toEqual({ scenes: [0, 1], composite: true });
  });
  test("always: every scene, every frame", () => {
    expect(renderSchedule(evaluateView(layout, 0.1), 3, "always")).toEqual({
      scenes: [0, 1, 2],
      composite: true,
    });
  });
});
