import * as THREE from "three";

/**
 * One lenticular "view": a photo on a subdivided plane whose vertices are
 * pushed towards the viewer by its depth map — the pARelax technique. The
 * plane sits behind the screen (display space, cm, screen at z = 0), so a
 * head-coupled camera sees it through the screen like a window.
 *
 * Unlike pARelax this uses a small unlit ShaderMaterial instead of
 * MeshPhongMaterial: the photo keeps its exact colours (no light baked over
 * it), and the colour path is identical whether the scene is drawn straight
 * to the canvas or into a render target for the prism compositor.
 */

// Displace each vertex *along the ray to the nominal eye* rather than straight
// along +z. Seen from the nominal eye the picture is then exactly the source
// image (nothing magnified for being "nearer"); move away from it and the
// layers separate with correct parallax. Pushing along +z instead (pARelax)
// enlarges near layers and bends anything whose depth varies, like trees.
const vertexShader = /* glsl */ `
uniform sampler2D depthMap;
uniform float relief;      // cm a white (near) pixel comes forward
uniform vec3 nominalEye;   // where the picture is unprojected from, cm
varying vec2 vUv;
void main() {
  vUv = uv;
  float d = texture2D(depthMap, uv).r;
  vec4 world = modelMatrix * vec4(position, 1.0);            // on the far plane
  float t = d * relief / max(nominalEye.z - world.z, 1e-3);  // fraction of the way to the eye
  world.xyz = mix(world.xyz, nominalEye, t);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
  #include <colorspace_fragment>
}
`;

async function toTexture(source, { color }) {
  let texture;
  if (source?.isTexture) {
    texture = source;
  } else if (typeof source === "string") {
    texture = await new THREE.TextureLoader().loadAsync(source);
  } else if (source instanceof HTMLCanvasElement) {
    texture = new THREE.CanvasTexture(source);
  } else if (source && "width" in source && "height" in source) {
    texture = new THREE.Texture(source);
    texture.needsUpdate = true;
  } else {
    throw new TypeError("scene map/depthMap must be a URL, an image/canvas, or a THREE.Texture");
  }
  if (color) {
    texture.colorSpace = THREE.SRGBColorSpace;
  } else {
    // depth is data, not colour; the vertex shader reads it at LOD 0
    texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
  }
  texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export default class ParallaxScene {
  /**
   * @param {object} desc
   * @param {string|HTMLCanvasElement|HTMLImageElement|THREE.Texture} desc.map       colour image
   * @param {string|HTMLCanvasElement|HTMLImageElement|THREE.Texture} desc.depthMap  white = near
   * @param {number} [desc.depth=1]  relief multiplier for this scene (like pARelax's `depth`)
   * @param {string} [desc.label]
   */
  constructor(desc) {
    this.desc = desc;
    this.label = desc.label ?? "";
    this.depth = Number.isFinite(desc.depth) ? desc.depth : 1;
    this.scene = new THREE.Scene();
    this.mesh = null;
    this.aspect = 16 / 9;
  }

  async load() {
    const [map, depthMap] = await Promise.all([
      toTexture(this.desc.map, { color: true }),
      toTexture(this.desc.depthMap, { color: false }),
    ]);
    const img = map.image;
    this.aspect = img && img.width && img.height ? img.width / img.height : 16 / 9;

    // ~320 columns is plenty for a depth map: the relief is smooth, the colour is per-pixel
    const segX = 320;
    const segY = Math.max(16, Math.round(segX / this.aspect));
    const geometry = new THREE.PlaneGeometry(1, 1, segX, segY);
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        map: { value: map },
        depthMap: { value: depthMap },
        relief: { value: 10 },
        nominalEye: { value: new THREE.Vector3(0, 0, 50) },
      },
    });
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.frustumCulled = false; // vertices move in the shader
    this.scene.add(this.mesh);
    return this;
  }

  /**
   * Size and place the plane so it always fills the screen "window".
   *
   * @param {object} o
   * @param {number} o.screenW     physical screen width, cm
   * @param {number} o.screenH     physical screen height, cm
   * @param {number} o.backCm      how far behind the screen the far (black) plane sits
   * @param {number} o.reliefCm    displacement of a white (near) pixel, before this scene's `depth`
   * @param {number} o.maxEyeX     largest lateral eye offset the camera will use, cm
   * @param {number} o.maxEyeY     largest vertical eye offset, cm
   * @param {number} o.minEyeZ     closest viewing distance the camera will use, cm
   * @param {number} o.distance    nominal viewing distance (straight in front of the centre), cm
   */
  layout({ screenW, screenH, backCm, reliefCm, maxEyeX, maxEyeY, minEyeZ, distance }) {
    if (!this.mesh) return;
    // The window edge seen from the most extreme eye position lands this far
    // out on the far plane; cover that box with the image (centre-crop).
    const halfW = screenW / 2 + (screenW / 2 + maxEyeX) * (backCm / minEyeZ);
    const halfH = screenH / 2 + (screenH / 2 + maxEyeY) * (backCm / minEyeZ);
    let w = 2 * halfW;
    let h = 2 * halfH;
    if (w / h > this.aspect) h = w / this.aspect;
    else w = h * this.aspect;
    this.mesh.scale.set(w, h, 1);
    this.mesh.position.set(0, 0, -backCm);
    this.mesh.updateMatrixWorld(true);
    this.material.uniforms.relief.value = reliefCm * this.depth;
    this.material.uniforms.nominalEye.value.set(0, 0, distance);
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.material.uniforms.map.value?.dispose();
    this.material.uniforms.depthMap.value?.dispose();
    this.material.dispose();
  }
}
