/**
 * @jest-environment node
 */
import * as THREE from "three";
import { eyeFromFaceMatrix, ManualTracker } from "./trackers";

// A face estimate laid out exactly as MindAR's estimator returns it (row-major):
// face 6 cm to the viewer's right, 3 cm above the camera (OpenCV y points down), 48 cm away.
const tx = 6;
const ty = -3;
const tz = 48;
const R = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
const faceMatrix = [
  R[0][0], R[0][1], R[0][2], tx,
  -R[1][0], -R[1][1], -R[1][2], -ty,
  -R[2][0], -R[2][1], -R[2][2], -tz,
  0, 0, 0, 1,
];

describe("MindAR face matrix", () => {
  test("eyeFromFaceMatrix reads the row-major translation", () => {
    expect(eyeFromFaceMatrix(faceMatrix)).toEqual({ x: 6, y: 3, z: 48 });
  });

  test("agrees with three.js when the matrix is applied the way MindARThree does (set, row-major)", () => {
    const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().set(...faceMatrix));
    const eye = eyeFromFaceMatrix(faceMatrix);
    expect([p.x, p.y, -p.z]).toEqual([eye.x, eye.y, eye.z]);
  });

  test("Matrix4.fromArray (column-major) would lose the translation — the pARelax pitfall", () => {
    const p = new THREE.Vector3().setFromMatrixPosition(new THREE.Matrix4().fromArray(faceMatrix));
    expect(p.toArray()).toEqual([0, 0, 0]);
  });
});

describe("ManualTracker", () => {
  test("reports the view position it was given", () => {
    const t = new ManualTracker(0.2).start();
    expect(t.getPose()).toEqual({ v: 0.2, vy: 0.5, tracking: true });
    t.set(0.7, 0.4);
    expect(t.getPose()).toEqual({ v: 0.7, vy: 0.4, tracking: true });
  });
});
