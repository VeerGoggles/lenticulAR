/**
 * Off-axis ("head-coupled") projection: the screen is a fixed window in the
 * scene and the camera sits at the viewer's eye, so the frustum is skewed
 * to pass exactly through the screen's edges. Content on the screen plane
 * stays put; content behind it slides the way it would through real glass.
 *
 * pARelax moves the camera with the face but keeps a centred frustum, which
 * slides the whole picture around the screen. Skewing the frustum is the
 * same idea with the window pinned.
 *
 * Display space: centimetres, origin at the screen centre, +x right, +y up,
 * +z out of the screen towards the viewer.
 *
 * @param {THREE.PerspectiveCamera} camera
 * @param {{x:number,y:number,z:number}} eye   eye position, cm (z > 0)
 * @param {number} screenW                     physical screen width, cm
 * @param {number} screenH                     physical screen height, cm
 */
export function updateOffAxisCamera(camera, eye, screenW, screenH, near = 1, far = 4000) {
  const z = Math.max(eye.z, near * 1.01);
  camera.position.set(eye.x, eye.y, z);
  camera.quaternion.identity(); // always looking straight down -z, at the screen
  camera.updateMatrixWorld(true);

  const k = near / z;
  const left = (-screenW / 2 - eye.x) * k;
  const right = (screenW / 2 - eye.x) * k;
  const top = (screenH / 2 - eye.y) * k;
  const bottom = (-screenH / 2 - eye.y) * k;
  camera.near = near;
  camera.far = far;
  camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}
