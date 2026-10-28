#!/usr/bin/env python3
"""
Regenerate the frames, animation and measurements in docs/results/.

    npm run build
    pip install -r scripts/requirements.txt
    python -m playwright install chromium
    python scripts/capture_results.py          # needs ffmpeg on PATH for the animation
    python scripts/make_figures.py             # charts + diagrams from the JSON written here

The production build is served from a throwaway local HTTP server and driven
in headless Chromium through the deterministic hooks that `?capture=1`
exposes (window.lenticulAR.frame(v) renders exactly one frame at view
position v, with smoothing off). By default WebGL runs on SwiftShader, the
software rasteriser, so results are reproducible on any machine; pass --gpu
to use the real GPU instead (timings then reflect your hardware).
"""

from __future__ import annotations

import argparse
import base64
import functools
import http.server
import io
import json
import math
import shutil
import socketserver
import statistics
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
W, H = 1280, 720
BAND = 0.05  # default transition half-width
A_START, A_END = 1 / 3 - BAND, 1 / 3 + BAND

BG = (14, 17, 22)
INK = (236, 231, 221)
INK_DIM = (160, 156, 148)


# ------------------------------------------------------------------ helpers


def font(size: int, weight: str = "Regular") -> ImageFont.ImageFont:
    for path in (
        f"/usr/share/fonts/opentype/inter/Inter-{weight}.otf",
        f"/Library/Fonts/Inter-{weight}.otf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "C:/Windows/Fonts/segoeui.ttf",
    ):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def v_at(progress: float, band_start: float = A_START, width: float = 2 * BAND) -> float:
    """View position for a linear progress through a transition band."""
    return band_start + progress * width


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve(directory: Path) -> tuple[socketserver.TCPServer, str]:
    handler = functools.partial(QuietHandler, directory=str(directory))
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, f"http://127.0.0.1:{httpd.server_address[1]}/"


class Capture:
    """One headless page running the built app in capture mode."""

    def __init__(self, browser, base_url: str):
        self.ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
        self.page = self.ctx.new_page()
        self.page.on("pageerror", lambda e: print("  page error:", e))
        self.base = base_url

    def open(self, params: str = "", v: float = 0.5) -> "Capture":
        self.page.goto(f"{self.base}?capture=1&dpr=1&v={v}&{params}", timeout=300_000, wait_until="domcontentloaded")
        self.page.wait_for_function("window.lenticulAR && window.lenticulAR.ready === true", timeout=300_000)
        return self

    def frame(self, v: float, vy: float = 0.5) -> dict:
        return self.page.evaluate(f"window.lenticulAR.frame({v}, {vy})")

    def options(self, patch: dict) -> None:
        self.page.evaluate(f"window.lenticulAR.setOptions({json.dumps(patch)})")

    def eval(self, js: str):
        return self.page.evaluate(js)

    def canvas(self) -> Image.Image:
        """The WebGL canvas only (no HUD) — needs preserveDrawingBuffer, which capture mode sets."""
        url = self.page.evaluate("window.lenticulAR.engine.renderer.domElement.toDataURL('image/png')")
        return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGB")

    def screenshot(self) -> Image.Image:
        """The whole page, HUD included."""
        return Image.open(io.BytesIO(self.page.screenshot())).convert("RGB")

    def close(self) -> None:
        self.ctx.close()


def contact_sheet(tiles, captions, cols, tile_w, out: Path, title: str | None = None, sub: str | None = None):
    """Grid of frames with a caption under each, on the app's background colour."""
    tile_h = round(tile_w * H / W)
    pad, cap_h = 14, 46
    head = 0
    f_title, f_sub, f_cap, f_cap2 = font(26, "SemiBold"), font(17), font(17, "Medium"), font(15)
    if title:
        head = 64 if sub else 44
    rows = math.ceil(len(tiles) / cols)
    sheet = Image.new("RGB", (pad + cols * (tile_w + pad), head + pad + rows * (tile_h + cap_h + pad)), BG)
    d = ImageDraw.Draw(sheet)
    if title:
        d.text((pad, 12), title, font=f_title, fill=INK)
        if sub:
            d.text((pad, 44), sub, font=f_sub, fill=INK_DIM)
    for k, (im, cap) in enumerate(zip(tiles, captions)):
        x = pad + (k % cols) * (tile_w + pad)
        y = head + pad + (k // cols) * (tile_h + cap_h + pad)
        sheet.paste(im.resize((tile_w, tile_h), Image.LANCZOS), (x, y))
        line1, _, line2 = cap.partition("\n")
        d.text((x + 2, y + tile_h + 6), line1, font=f_cap, fill=INK)
        if line2:
            d.text((x + 2, y + tile_h + 26), line2, font=f_cap2, fill=INK_DIM)
    sheet.save(out, optimize=True)
    print(f"  wrote {out.relative_to(ROOT)}")


def srgb_to_linear(a: np.ndarray) -> np.ndarray:
    c = a.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def caption_for(stats: dict, labels) -> str:
    name = lambda k: labels[k].split(" ")[0]  # "A", "B", "C"
    if stats["zone"] == "rest":
        return f"v {stats['v']:.3f} · at rest\nscene {name(stats['from'])} · 1 scene rendered"
    return (
        f"v {stats['v']:.3f} · {name(stats['from'])}→{name(stats['to'])} {stats['progress'] * 100:.0f}%\n"
        f"prism step {stats['stepAngleDeg']:.0f}° · 2 scenes + prisms"
    )


# ------------------------------------------------------------------ captures


def capture_scenes(cap: Capture, out: Path):
    print("scenes at rest")
    cap.open("hud=0")
    tiles, caps = [], []
    for v, zone in [(1 / 6, "0 – 0.283"), (0.5, "0.383 – 0.617"), (5 / 6, "0.717 – 1")]:
        s = cap.frame(v)
        tiles.append(cap.canvas())
        caps.append(f"{s['labels'][s['from']]}\nrest zone v {zone} · 1 scene rendered")
    contact_sheet(tiles, caps, 3, 600, out / "scenes.png")


def capture_transition(cap: Capture, out: Path):
    print("A→B transition contact sheet")
    cap.open("hud=0")
    tiles, caps = [], []
    for p in [None, 0.12, 0.28, 0.42, 0.5, 0.62, 0.8, "after"]:
        if p is None:
            v = A_START - 0.004
        elif p == "after":
            v = A_END + 0.004
        else:
            v = v_at(p)
        s = cap.frame(v)
        tiles.append(cap.canvas())
        caps.append(caption_for(s, s["labels"]))
    contact_sheet(
        tiles,
        caps,
        4,
        440,
        out / "transition-a-b.png",
        title="Crossing the A → B band (v = 1/3 ± 0.05)",
        sub="24 triangular prisms, print mapping, lockstep rotation, smoothstep easing",
    )


def sweep_path(n_frames: int) -> list[float]:
    """v(t) that crosses the view range and back, slowing down inside the bands."""
    lo, hi = 0.06, 0.94
    vs = np.linspace(lo, hi, 4001)
    in_band = (np.abs(vs - 1 / 3) < BAND) | (np.abs(vs - 2 / 3) < BAND)
    speed = np.where(in_band, 0.32, 1.0)
    t = np.concatenate([[0], np.cumsum(np.diff(vs) / speed[1:])])
    t /= t[-1]
    half = n_frames // 2
    # ease each pass in and out so the loop has no visible jolt at the ends
    u = np.linspace(0, 1, half)
    u = u * u * (3 - 2 * u)
    there = np.interp(u, t, vs)
    return list(there) + list(there[::-1])


def capture_sweep(cap: Capture, out: Path, fps: int = 30, seconds: float = 13.0):
    print("sweep animation (HUD on)")
    if not shutil.which("ffmpeg"):
        print("  ffmpeg not found — skipping the animation")
        return
    cap.open("hud=1")
    path = sweep_path(int(fps * seconds))
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for i, v in enumerate(path):
            cap.frame(float(v))
            cap.page.screenshot(path=str(tmp / f"{i:05d}.png"))
            if i % 60 == 0:
                print(f"  frame {i}/{len(path)}")
        mp4 = out / "sweep.mp4"
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(fps), "-i", str(tmp / "%05d.png"),
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-movflags", "+faststart", str(mp4)],
            check=True,
        )
        print(f"  wrote {mp4.relative_to(ROOT)}")
        gif = out / "sweep.gif"
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-framerate", str(fps), "-i", str(tmp / "%05d.png"),
             "-vf", "fps=10,scale=720:-1:flags=lanczos,split[a][b];"
                    "[a]palettegen=max_colors=96:stats_mode=diff[p];"
                    "[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle",
             "-loop", "0", str(gif)],
            check=True,
        )
        print(f"  wrote {gif.relative_to(ROOT)} ({gif.stat().st_size / 1e6:.1f} MB)")


def capture_variants(cap: Capture, out: Path):
    print("mapping × prism-count variants")
    tiles, caps = [], []
    v = v_at(0.4)
    for mapping in ("print", "mask"):
        for count in (12, 32, 96):
            cap.open(f"hud=0&prisms={count}&mapping={mapping}")
            s = cap.frame(v)
            tiles.append(cap.canvas())
            caps.append(f"{mapping} mapping · {count} prisms\nprism step {s['stepAngleDeg']:.0f}°")
    contact_sheet(
        tiles,
        caps,
        3,
        440,
        out / "variants.png",
        title="Face mapping × prism pitch, same moment of the A → B turn",
        sub="print: each face carries its strip (tri-vision)  ·  mask: faces are apertures onto screen-locked scenes",
    )


def capture_stagger(cap: Capture, out: Path):
    print("stagger (sweep) variants")
    tiles, caps = [], []
    for stagger in (0, 0.6, 1.5):
        cap.open(f"hud=0&prisms=48&stagger={stagger}")
        cap.frame(v_at(0.5))
        tiles.append(cap.canvas())
        caps.append(
            f"stagger {stagger}\n"
            + ("all prisms in lockstep" if stagger == 0 else "flip sweeps left → right as v increases")
        )
    contact_sheet(
        tiles,
        caps,
        3,
        440,
        out / "stagger.png",
        title="Synchronised vs. sweeping flips, half-way through the band",
        sub="48 prisms · every prism still starts at rest on the band's edge and finishes on the other",
    )


def capture_debug_faces(cap: Capture, out: Path):
    print("face-id view")
    v = v_at(0.36)
    cap.open("hud=0&prisms=24&debug=faces")
    cap.frame(v)
    ids = cap.canvas()
    cap.open("hud=0&prisms=24")
    s = cap.frame(v)
    contact_sheet(
        [ids, cap.canvas()],
        [
            "face ids: outgoing A red · incoming B green · gap black",
            f"rendered · prism step {s['stepAngleDeg']:.0f}°",
        ],
        2,
        620,
        out / "debug-faces.png",
    )


# ------------------------------------------------------------- measurements


def verify(cap: Capture) -> dict:
    print("verification: GPU coverage vs CPU reference")
    cap.open("hud=0&prisms=16&easing=linear&debug=faces&samples=4")
    pitch = W / 16
    x0, x1 = int(2 * pitch), int(14 * pitch)  # skip the outer two prisms at each edge
    rows, worst = [], 0.0
    for deg in range(0, 121, 5):
        p = deg / 120
        v = v_at(p) if 0 < p < 1 else (A_START + 1e-9 if p == 0 else A_END - 1e-9)
        s = cap.frame(v)
        theta = s["eased"] * 2 * math.pi / 3
        lin = srgb_to_linear(np.asarray(cap.canvas()))[:, x0:x1]
        gpu_a, gpu_b = float(lin[..., 0].mean()), float(lin[..., 1].mean())
        gpu_gap = 1 - gpu_a - gpu_b
        cpu = cap.eval(f"window.lenticulAR.math.faceCoverage({theta}, 3, 1, 8000)")
        err = max(abs(gpu_a - cpu["faces"][0]), abs(gpu_b - cpu["faces"][1]), abs(gpu_gap - cpu["gap"]))
        worst = max(worst, err)
        rows.append(
            {
                "angleDeg": round(math.degrees(theta), 3),
                "gpu": {"A": gpu_a, "B": gpu_b, "gap": gpu_gap},
                "cpu": {"A": cpu["faces"][0], "B": cpu["faces"][1], "gap": cpu["gap"]},
                "absError": err,
            }
        )
    print(f"  worst coverage error {worst * 100:.2f}% of a strip")

    print("verification: staggered flip, prism by prism")
    stagger_rows, stagger_worst = [], 0.0
    for stagger in (1.0, -0.6):
        cap.open(f"hud=0&prisms=16&easing=linear&debug=faces&samples=4&stagger={stagger}")
        cap.frame(v_at(0.5))
        lin = srgb_to_linear(np.asarray(cap.canvas()))
        cpu = cap.eval(
            f"""(() => {{
              const m = window.lenticulAR.math, count = 16, alpha = 2 * Math.PI / 3, stagger = {stagger};
              const thetaOf = (j) => m.EASINGS.linear(m.prismProgress(0.5, (j + 0.5) / count, stagger)) * alpha;
              const out = [];
              for (let j = 0; j < count; j++) {{
                let a = 0, b = 0; const n = 2000;
                for (let k = 0; k < n; k++) {{
                  const hit = m.castScreen(j + (k + 0.5) / n, count, thetaOf, 3, 1);
                  if (hit && hit.face === 0) a++; else if (hit && hit.face === 1) b++;
                }}
                out.push([a / n, b / n, m.prismProgress(0.5, (j + 0.5) / count, stagger)]);
              }}
              return out;
            }})()"""
        )
        for j in range(1, 15):
            strip = lin[:, int(j * pitch):int((j + 1) * pitch)]
            ga, gb = float(strip[..., 0].mean()), float(strip[..., 1].mean())
            ca, cb, pj = cpu[j]
            err = max(abs(ga - ca), abs(gb - cb), abs((1 - ga - gb) - (1 - ca - cb)))
            stagger_worst = max(stagger_worst, err)
            stagger_rows.append({"stagger": stagger, "prism": j, "progress": pj, "gpu": [ga, gb], "cpu": [ca, cb], "absError": err})
    print(f"  worst per-prism coverage error {stagger_worst * 100:.2f}% of a strip")

    print("verification: compositor at rest vs the direct (1-scene) path")
    cap.open("hud=0")
    handoff = []
    for v in (0.1, 0.5, 0.9):
        cap.options({"scheduling": "lazy"})
        cap.frame(v)
        a = np.asarray(cap.canvas()).astype(int)
        cap.options({"scheduling": "always"})  # same frame, but forced through the compositor at rest
        cap.frame(v)
        c = np.asarray(cap.canvas()).astype(int)
        diff = np.abs(a - c)
        handoff.append(
            {
                "v": v,
                "maxAbsDiff": int(diff.max()),
                "meanAbsDiff": float(diff.mean()),
                "pixelsDiffering": float(np.count_nonzero(diff.max(axis=2)) / (W * H)),
            }
        )
    cap.options({"scheduling": "lazy"})
    print("  ", ", ".join(f"v={h['v']}: max |Δ| {h['maxAbsDiff']}" for h in handoff))

    print("verification: band-edge continuity")
    edges = []
    for name, rest_v, in_v in [
        ("A→B start", A_START - 1e-7, A_START + 1e-7),
        ("A→B end", A_END + 1e-7, A_END - 1e-7),
    ]:
        sr = cap.frame(rest_v)
        a = np.asarray(cap.canvas()).astype(int)
        si = cap.frame(in_v)
        b = np.asarray(cap.canvas()).astype(int)
        diff = np.abs(a - b)
        edges.append(
            {
                "edge": name,
                "restPasses": sr["scenePasses"],
                "transitionPasses": si["scenePasses"],
                "maxAbsDiff": int(diff.max()),
                "meanAbsDiff": float(diff.mean()),
            }
        )
    print("  ", ", ".join(f"{e['edge']}: max |Δ| {e['maxAbsDiff']}" for e in edges))

    print("verification: render schedule across the whole range")
    # The decision is what's measured here, not the pixels: render tiny, and wait
    # for every frame so no GPU backlog is left behind for the next page load.
    cap.options({"pixelRatio": 0.1, "syncTimings": True})
    sched = cap.eval(
        """(() => {
          const out = [];
          for (let i = 0; i <= 1000; i++) {
            const s = window.lenticulAR.frame(i / 1000);
            out.push([s.v, s.scenePasses, s.composite ? 1 : 0]);
          }
          return out;
        })()"""
    )
    cap.options({"pixelRatio": 1, "syncTimings": False})
    passes = [p for _, p, _ in sched]
    in_band = [abs(v - 1 / 3) < BAND or abs(v - 2 / 3) < BAND for v, _, _ in sched]
    schedule = {
        "samples": len(sched),
        "maxScenePasses": max(passes),
        "restFramesWithOnePass": sum(1 for p, b in zip(passes, in_band) if not b and p == 1),
        "restFrames": sum(1 for b in in_band if not b),
        "bandFramesWithTwoPasses": sum(1 for p, b in zip(passes, in_band) if b and p == 2),
        "bandFrames": sum(1 for b in in_band if b),
    }
    print("  ", schedule)
    return {
        "coverage": rows,
        "coverageWorstAbsError": worst,
        "stagger": stagger_rows,
        "staggerWorstAbsError": stagger_worst,
        "handoff": handoff,
        "bandEdges": edges,
        "schedule": schedule,
    }


def benchmark(cap: Capture, repeats: int = 3) -> dict:
    print("benchmark: lazy vs always (1-px readback after each frame so GPU work is timed)")
    cap.open("hud=0")
    info = cap.eval(
        """(() => {
          const gl = window.lenticulAR.engine.renderer.getContext();
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
                   drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight] };
        })()"""
    )
    vs = [round(x, 4) for x in np.linspace(0.0125, 0.9875, 79)]
    series = {}
    for mode in ("lazy", "always"):
        cap.options({"scheduling": mode, "syncTimings": True})
        pts = []
        for v in vs:
            cap.frame(v)  # warm-up (also allocates targets on first use)
            times, s = [], None
            for _ in range(repeats):
                s = cap.frame(v)
                times.append(s["frameMs"])
            pts.append({"v": v, "ms": statistics.median(times), "passes": s["scenePasses"], "composite": s["composite"], "zone": s["zone"]})
        series[mode] = pts
        rest = [p["ms"] for p in pts if p["zone"] == "rest"]
        band = [p["ms"] for p in pts if p["zone"] == "transition"]
        print(f"  {mode:6s}: rest median {statistics.median(rest):6.1f} ms · band median {statistics.median(band):6.1f} ms")
    cap.options({"scheduling": "lazy", "syncTimings": False})

    def summary(mode, zone):
        ms = [p["ms"] for p in series[mode] if p["zone"] == zone]
        return {"medianMs": statistics.median(ms), "meanMs": statistics.fmean(ms), "frames": len(ms)}

    whole = {m: statistics.fmean(p["ms"] for p in series[m]) for m in series}
    return {
        "environment": {**info, "viewport": [W, H], "devicePixelRatio": 1, "prisms": 24, "samples": 4, "repeats": repeats},
        "series": series,
        "summary": {
            mode: {"rest": summary(mode, "rest"), "transition": summary(mode, "transition"), "sweepMeanMs": whole[mode]}
            for mode in series
        },
        "sweepSpeedup": whole["always"] / whole["lazy"],
    }


# ---------------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--build", type=Path, default=ROOT / "build", help="production build to serve (npm run build)")
    ap.add_argument("--out", type=Path, default=ROOT / "docs" / "results")
    ap.add_argument("--gpu", action="store_true", help="use the real GPU instead of SwiftShader")
    ap.add_argument(
        "--only",
        nargs="*",
        choices=["scenes", "transition", "sweep", "variants", "stagger", "debug", "verify", "bench"],
        help="run a subset",
    )
    args = ap.parse_args()
    if not (args.build / "index.html").exists():
        raise SystemExit(f"no build at {args.build} — run `npm run build` first")
    args.out.mkdir(parents=True, exist_ok=True)
    want = set(args.only or ["scenes", "transition", "sweep", "variants", "stagger", "debug", "verify", "bench"])

    httpd, base = serve(args.build)
    flags = [] if args.gpu else ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
    t0 = time.time()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=flags)
            cap = Capture(browser, base)
            if "scenes" in want:
                capture_scenes(cap, args.out)
            if "transition" in want:
                capture_transition(cap, args.out)
            if "variants" in want:
                capture_variants(cap, args.out)
            if "stagger" in want:
                capture_stagger(cap, args.out)
            if "debug" in want:
                capture_debug_faces(cap, args.out)
            if "verify" in want:
                res = verify(cap)
                (args.out / "verification.json").write_text(json.dumps(res, indent=2))
                print(f"  wrote {(args.out / 'verification.json').relative_to(ROOT)}")
            if "bench" in want:
                res = benchmark(cap)
                (args.out / "benchmark.json").write_text(json.dumps(res, indent=2))
                print(f"  wrote {(args.out / 'benchmark.json').relative_to(ROOT)}")
            if "sweep" in want:
                capture_sweep(cap, args.out)
            cap.close()
            browser.close()
    finally:
        httpd.shutdown()
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
