# Method

How lenticulAR fakes a lenticular print, step by step, with the numbers the
code actually uses. Everything here is implemented in
[`src/engine/`](../src/engine) and pinned down by the Jest suite in the same
folder; the GLSL in `PrismCompositor.js` mirrors `prismGeometry.js` line for
line, and the results harness checks the two against each other on the GPU.

Coordinates throughout are **display space**: centimetres, origin at the
centre of the screen, +x to the viewer's right, +y up, +z out of the screen
towards the viewer.

---

## 1. Where is the viewer? → view position `v`

A lenticular print shows a different image depending on the **angle** you view
it from. lenticulAR reduces the viewer to one number, the view position
`v ∈ [0, 1]` across the screen's viewing range:

```
v = ½ + atan2(eₓ, e_z) / Φ          Φ = view cone (default 40°)
```

* **Face tracking** (MindAR, as in pARelax). The tracked face gives the eye
  position `e`. Angle-based, so walking towards or away from the screen does
  not change the scene — only moving sideways does, exactly like a print.
  With the default 40° cone, `v = 1/3` sits 6.7° left of centre: about 6 cm
  of head movement at 50 cm.
* **Pointer** (mouse/touch). `v = clientX / innerWidth` — literally "how far
  across the screen" — and the eye is placed where face tracking would have
  put it: `eₓ = d · tan((v − ½) Φ)` at the nominal viewing distance `d`.

The eye is smoothed with a time-based exponential (`smoothingMs`, default
70 ms) on top of MindAR's own one-euro filter, and `v` is computed from the
smoothed eye, so both trackers go through the same mapping.

### Reading MindAR's face matrix

MindAR returns `faceMatrix` as a **row-major** 4×4 array (MindARThree applies
it with `Matrix4.set(...m)`), translation in centimetres at indices 3, 7 and
11, with the face in front of the camera at negative z. lenticulAR reads it
as

```js
eye = { x: m[3], y: m[7], z: -m[11] };   // cm, relative to the webcam
```

`Matrix4.fromArray(m)` treats the array as column-major and picks up
`m[12..14] = 0` as the translation instead, so the head position never
reaches the camera — see [Differences from pARelax](#7-differences-from-parelax).

---

## 2. View zones: one scene at rest, two in a band

With `N` scenes the range is split by `N − 1` boundaries `b_k` (default
`k / N`: 1/3 and 2/3 for three scenes). Around each boundary is a transition
band of half-width `h` (default 0.05 — "5 % of the screen before and after"):

| v | zone | visible | rendered | prisms |
|---|---|---|---|---|
| 0 – 0.283 | rest | A | **1** scene, straight to the canvas | at rest on face A |
| 0.283 – 0.383 | band A→B | A and B | **2** scenes + compositor | turning A → B |
| 0.383 – 0.617 | rest | B | **1** | at rest on face B |
| 0.617 – 0.717 | band B→C | B and C | **2** + compositor | turning B → C |
| 0.717 – 1 | rest | C | **1** | at rest on face C |

Inside band `k` the linear progress is `p = (v − (b_k − h)) / 2h`, eased with
smoothstep (or linear / smootherstep) to `e`, and the prisms sit at

```
θ = (k + e) · α,        α = 2π / K,   K = max(3, N) faces per prism
```

so one band turns the prisms exactly one face (120° for triangles). Band
edges are **open intervals**: exactly on an edge the prisms are at rest and
only one scene is drawn. `createViewLayout` rejects bands that overlap or
leave `[0, 1]`; a zero half-width degrades to a hard switch.

**Stagger.** A real lenticular sheet seen from a finite distance does not
flip all at once — each lenslet sees the viewer at a slightly different angle,
so the flip line sweeps across the print in the direction you move. With
`stagger = k`, prism `j` (centre at `x̂ⱼ` across the screen) uses

```
pⱼ = clamp(p · (1 + k) − k · x̂ⱼ, 0, 1)
```

`k = 0` is lockstep (the default — "synchronised"). For any `k`, every prism
is at rest at `p = 0` and finished at `p = 1`, so the band edges stay seamless
and the 1-scene / 2-scene schedule still holds. Negative `k` sweeps
right-to-left.

---

## 3. The rotating-prism mask

The screen is covered by `n` vertical prisms (default 24), one per strip of
width `w = W / n`. Each is a regular K-gon in cross-section whose **face width
equals the pitch**, so at rest the front faces tile the screen with no gaps
and no overlaps. Face `f` carries scene `f`.

![prism cross-section](results/prism-cross-section-light.svg)

Working in units of the pitch:

| quantity | formula | triangle (K = 3) |
|---|---|---|
| apothem (axis → face) | `a = 1 / (2 tan(π/K))` | 0.289 |
| circumradius (axis → edge) | `R = 1 / (2 sin(π/K))` | 0.577 |
| normal of face f at rotation θ | `ψ_f = dir · (f·α − θ)` | |
| silhouette width | `cos θ` for θ ≤ 30°, `cos(60° − θ)` up to 60°, period 60° | 1 → 0.866 → 1 |

With `dir = +1` the incoming face swings in from the right while the outgoing
one turns away to the left: the prism "shows you its right side" as you move
right.

**Per pixel** the compositor casts an orthographic ray (the prisms lie on the
screen plane like a lenticular sheet laminated onto the display) at offset
`s` from a prism's axis:

```
n = (sin ψ, cos ψ)                 skip unless n_z > 0 (front-facing)
z = (a − nₓ s) / n_z               intersection with the face's plane
u = s n_z − z nₓ                   position along the face, −½ … ½
hit if |u| ≤ ½                     front-most hit wins
```

It tests the pixel's own prism **and both neighbours**: a turning triangle's
corners overhang its strip by `R − ½ = 0.077` pitch, and square-or-wider prisms
occlude each other. Testing only the own prism would put the gaps in the wrong
place. During a step only the outgoing and incoming faces can face the viewer,
so each prism costs two face tests.

What a hit shows depends on the **face mapping**:

* **print** (default) — the face carries its own strip of the scene, like a
  printed tri-vision slat: `x_sample = (j + ½ + u) · w`. Turning a face
  foreshortens its picture.
* **mask** — the face is an aperture onto a screen-locked scene:
  `x_sample = x`. The scenes stay still and the slats wipe between them; with
  fine pitch this is the interleaved "ghost" look of a real lenticular flip.

Values between 0 and 1 blend the two.

**Shading.** Face brightness is the Lambert term *relative to a front-on face*,
`L(n) = max(n·l, 0) / l_z`, blended in by `shading` (default 0.45): exactly
1 at rest. A crease darkening towards each face's edges and a soft specular
glint are both scaled by `sin(π · e)`, so they vanish at rest too. Where a ray
misses every prism (the gaps that open while the slats turn — up to
`1 − cos 30° = 13.4 %` of each strip at 30° and 90°) the compositor shows a
dark backing with `gapFill` (default 0.3) of the scene showing through.

**Antialiasing.** Prism edges are vertical, so the compositor supersamples
horizontally only: up to 4 sub-samples per pixel, each with its own face test.

**Cost.** In lockstep every prism has the same rotation, so the two face
normals are computed once per frame on the CPU and passed as uniforms; only a
staggered flip evaluates them per prism. A neighbour is only tested when the
sub-sample lies within its circumradius, which rules it out for most pixels.
What is left per sub-sample is a handful of multiply-adds and one texture read.

---

## 4. Render only what can be seen

```
                 view position v
                       │
             ┌─────────┴──────────┐
        rest zone            transition band
             │                    │
   scene k → canvas      scene from → RT₀   (sRGB8)
      (1 pass)           scene to   → RT₁   (sRGB8)
                                  │
                       prism compositor → canvas
                           (2 passes + 1 full-screen)
```

The `lazy` schedule (default) renders one scene straight to the canvas at
rest and skips the compositor entirely; in a band it renders the two visible
scenes into two render targets and composites them. It never draws more than
two scenes. The `always` schedule — every scene into its own target and the
compositor every frame — is kept as the naive baseline for benchmarking.

**Seamless hand-off.** Switching between the 1-pass and the 2-pass path at a
band edge must not show. At progress 0 (or 1) the compositor is an exact
identity: the front face has shading exactly 1, the crease/glint terms are 0,
and the scene is sampled at the pixel centre (the face mapping is applied as
an *offset from* the pixel centre, which is 0 at rest). The render targets
store **sRGB8** (`colorSpace: SRGBColorSpace`), so the round trip
scene → target → compositor → canvas is lossless to ±1/255, and the canvas is
rendered without MSAA so both paths rasterise identically. The results
harness measures this.

---

## 5. Depth-displaced parallax (from pARelax)

Each scene is a photo on a subdivided plane (320 columns) displaced by its
depth map — white = near, black = far, the MiDaS convention — so the layers
of a picture separate as the head moves. All scenes share one head-coupled
camera.

**Off-axis projection.** The screen is a fixed window: the camera sits at the
eye and its frustum is skewed to pass exactly through the screen's edges,

```
left   = (−W/2 − eₓ) · n / e_z      right = (W/2 − eₓ) · n / e_z
bottom = (−H/2 − e_y) · n / e_z     top   = (H/2 − e_y) · n / e_z
```

so content on the screen plane stays put and content behind it slides the way
it would through real glass. (pARelax moves the camera but keeps a centred
frustum, which slides the whole picture around.)

**Ray displacement.** Each vertex moves along the ray towards the nominal eye
`E₀ = (0, 0, d)` instead of straight along +z:

```
P = mix(P₀, E₀, depth · relief / (E₀.z − P₀.z))
```

Seen from `E₀` the picture is exactly the source image — nearer layers are not
magnified, and things whose depth varies (trees, people) do not bend. Away
from `E₀` the layers separate with correct parallax.

**Sizing.** The far plane sits `back` cm behind the screen (default 0.4 × the
screen width) and a white pixel comes `relief` cm forward (0.3 × width). The
camera's eye is clamped to the range the pointer mapping can reach (scaled by
`parallax`, default 0.6), and each plane is sized so that from any eye in that
range the screen window never shows its edge:

```
half-width = W/2 + (W/2 + max eₓ) · back / min e_z
```

then centre-cropped to the image's aspect. At the nominal eye the window shows
about 80 % of each picture.

**Physical model.** Screen width defaults to the CSS width at 96 px/inch
(clamped to 8–60 cm), viewing distance to 1.6 × the width (28–65 cm). All of
it can be overridden through `display`.

---

## 6. Colour pipeline

| stage | space |
|---|---|
| scene photo texture | sRGB, decoded to linear on sampling |
| scene shader output | linear → canvas (sRGB-encoded by three.js) or → sRGB8 render target (encoded by the GPU) |
| compositor input | sRGB8 target, decoded to linear on sampling |
| compositor output | linear → sRGB-encoded for the canvas |
| depth maps | data (`NoColorSpace`), read at LOD 0 in the vertex shader |

---

## 7. Differences from pARelax

| | pARelax | lenticulAR |
|---|---|---|
| scenes on screen | one at a time, cross-faded on a timer | one per view zone, chosen by head position |
| transition | timed visibility swap | rotating-prism mask driven by head position |
| render cost | every loaded photo stays in the scene | 1 scene at rest, 2 in a band |
| face matrix | `Matrix4.fromArray(faceMatrix)` — reads the row-major array as column-major, so the translation is always (0, 0, 0) | `eye = (m[3], m[7], −m[11])` |
| camera | translated, centred frustum | off-axis (head-coupled) frustum, screen pinned |
| displacement | along +z (`MeshPhongMaterial.displacementMap`) | along the ray to the nominal eye (custom shader) |
| material | Phong + hemisphere light | unlit, so photos keep their exact colours |
| tracker | `MindARThree` (its own renderer and canvas) | MindAR's face `Controller` only; MindAR is code-split and loaded on demand |
| fallback | none | mouse / touch, plus a scripted tracker for capture |

The face-matrix point is worth carrying back to pARelax: with `fromArray`, the
tracked head never moves the camera — it settles at `CAMERA_OFFSET`
(0, 0.4, 0), about 2 units from a 40-unit plane, which is the "tightly-zoomed
crop" its demo-image comments work around. Reading the matrix with
`new THREE.Matrix4().set(...m)` (or `fromArray(m).transpose()`) fixes it.
