#!/usr/bin/env python3
"""
Charts and diagrams for docs/results/, in light and dark variants (SVG).

    python scripts/make_figures.py

Reads verification.json and benchmark.json written by capture_results.py;
the two concept diagrams (view zones, prism cross-section) are computed here
from the same formulas as src/engine/viewZones.js and prismGeometry.js.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Polygon, Rectangle  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "results"

# Validated categorical steps (scene A / B / C) and chart chrome, per mode.
THEMES = {
    "light": {
        "surface": "#fcfcfb",
        "ink": "#0b0b0b",
        "ink2": "#52514e",
        "muted": "#898781",
        "grid": "#e1e0d9",
        "axis": "#c3c2b7",
        "band": "#efeee9",
        "scene": ["#eb6834", "#1baf7a", "#6250d6"],
        "accent": "#2a78d6",
        "neutral": "#898781",
        "faceC": "#c3c2b7",
        "prismFill": "#f0efec",
    },
    "dark": {
        "surface": "#1a1a19",
        "ink": "#f0efec",
        "ink2": "#c3c2b7",
        "muted": "#898781",
        "grid": "#2c2c2a",
        "axis": "#383835",
        "band": "#242423",
        "scene": ["#d95926", "#199e70", "#9085e9"],
        "accent": "#3987e5",
        "neutral": "#898781",
        "faceC": "#52514e",
        "prismFill": "#262625",
    },
}
SCENE_NAMES = ["A · Dusk", "B · Pines", "C · Neon"]

plt.rcParams.update(
    {
        "font.family": ["Inter", "DejaVu Sans"],
        "font.size": 10.5,
        "svg.fonttype": "path",  # text as outlines: renders the same everywhere
        "axes.spines.top": False,
        "axes.spines.right": False,
        "lines.solid_capstyle": "round",
        "lines.solid_joinstyle": "round",
    }
)


def style_axes(ax, t, grid_y=True):
    ax.set_facecolor(t["surface"])
    for side in ("left", "bottom"):
        ax.spines[side].set_color(t["axis"])
        ax.spines[side].set_linewidth(0.8)
    ax.tick_params(colors=t["muted"], labelcolor=t["ink2"], length=3, width=0.8)
    if grid_y:
        ax.grid(axis="y", color=t["grid"], linewidth=0.8)
        ax.set_axisbelow(True)


def title(fig, t, text, sub=None, y=0.975):
    fig.text(0.012, y, text, ha="left", va="top", fontsize=13.5, fontweight="bold", color=t["ink"])
    if sub:
        fig.text(0.012, y - 0.058, sub, ha="left", va="top", fontsize=10, color=t["ink2"])


PREVIEW_DIR = None  # set by --preview: also write PNGs there for a quick look


def save(fig, name, mode):
    path = OUT / f"{name}-{mode}.svg"
    fig.savefig(path, facecolor=fig.get_facecolor(), metadata={"Date": None})
    if PREVIEW_DIR:
        fig.savefig(Path(PREVIEW_DIR) / f"{name}-{mode}.png", facecolor=fig.get_facecolor(), dpi=110)
    plt.close(fig)
    print(f"  wrote {path.relative_to(ROOT)}")


# ------------------------------------------------- model (mirrors the JS)

BAND = 0.05
BOUNDS = [1 / 3, 2 / 3]


def smoothstep(x):
    return x * x * (3 - 2 * x)


def evaluate(v):
    for k, b in enumerate(BOUNDS):
        if b - BAND < v < b + BAND:
            p = (v - (b - BAND)) / (2 * BAND)
            return {"zone": "transition", "from": k, "to": k + 1, "turns": k + smoothstep(p), "passes": 2}
    scene = sum(v >= b for b in BOUNDS)
    return {"zone": "rest", "from": scene, "to": scene, "turns": scene, "passes": 1}


def apothem(K):
    return 1 / (2 * math.tan(math.pi / K))


def cast_ray(s, theta, K=3, direction=1):
    a = apothem(K)
    best = None
    for f in range(K):
        psi = direction * (f * 2 * math.pi / K - theta)
        nx, nz = math.sin(psi), math.cos(psi)
        if nz <= 1e-4:
            continue
        z = (a - nx * s) / nz
        u = s * nz - z * nx
        if abs(u) <= 0.5 + 1e-9 and (best is None or z > best[1]):
            best = (f, z)
    return best


def cast_screen(x, count, theta, K=3):
    i = math.floor(x)
    best = None
    for j in (i - 1, i, i + 1):
        if 0 <= j < count:
            hit = cast_ray(x - (j + 0.5), theta, K)
            if hit and (best is None or hit[1] > best[1]):
                best = hit
    return best[0] if best else None


# ------------------------------------------------------------- figures


def fig_view_zones(mode):
    t = THEMES[mode]
    fig = plt.figure(figsize=(10, 5.6), facecolor=t["surface"])
    title(fig, t, "View position picks the scene; the prisms turn only inside the bands",
          "v = viewer's position across the screen's view range · three scenes · bands at 1/3 and 2/3, ±5 %")
    gs = fig.add_gridspec(3, 1, height_ratios=[0.55, 1.15, 0.85], hspace=0.38, left=0.09, right=0.8, top=0.83, bottom=0.09)
    ax0, ax1, ax2 = (fig.add_subplot(gs[k]) for k in range(3))
    vs = [i / 2000 for i in range(2001)]
    ev = [evaluate(v) for v in vs]

    # (a) the zones themselves
    edges = [0, BOUNDS[0] - BAND, BOUNDS[0] + BAND, BOUNDS[1] - BAND, BOUNDS[1] + BAND, 1]
    for k in range(3):
        x0, x1 = edges[2 * k], edges[2 * k + 1]
        ax0.add_patch(Rectangle((x0, 0), x1 - x0, 1, facecolor=t["scene"][k], edgecolor=t["surface"], linewidth=2))
        ax0.text((x0 + x1) / 2, 0.5, f"{SCENE_NAMES[k]}\n1 scene rendered", ha="center", va="center",
                 color="#ffffff", fontsize=10, fontweight="bold", linespacing=1.35)
    for k, b in enumerate(BOUNDS):
        ax0.add_patch(Rectangle((b - BAND, 0), 2 * BAND, 1, facecolor=t["band"], edgecolor=t["surface"], linewidth=2))
        ax0.text(b, 0.5, f"{'AB'[k] if k == 0 else 'B'}→{'BC'[k]}\n2 + prisms", ha="center", va="center",
                 color=t["ink"], fontsize=9.5, linespacing=1.35)
    ax0.set_xlim(0, 1)
    ax0.set_ylim(0, 1)
    ax0.axis("off")

    # band shading behind the two plots
    for ax in (ax1, ax2):
        for b in BOUNDS:
            ax.axvspan(b - BAND, b + BAND, color=t["band"], linewidth=0, zorder=0)

    # (b) prism rotation
    style_axes(ax1, t)
    ax1.plot(vs, [e["turns"] * 120 for e in ev], color=t["accent"], linewidth=2)
    ax1.set_xlim(0, 1)
    ax1.set_ylim(-20, 260)
    ax1.set_yticks([0, 120, 240])
    ax1.set_yticklabels(["0°", "120°", "240°"])
    ax1.set_ylabel("prism rotation", color=t["ink2"])
    for k, y in enumerate([0, 120, 240]):
        ax1.annotate(f"face {'ABC'[k]} front-on", xy=(1.0, y), xytext=(1.02, y), xycoords=("axes fraction", "data"),
                     va="center", ha="left", fontsize=9.5, color=t["ink2"], annotation_clip=False)
    ax1.tick_params(labelbottom=False)

    # (c) scenes rendered per frame
    style_axes(ax2, t)
    ax2.step(vs, [3] * len(vs), where="post", color=t["neutral"], linewidth=2)
    ax2.step(vs, [e["passes"] for e in ev], where="post", color=t["accent"], linewidth=2)
    ax2.set_xlim(0, 1)
    ax2.set_ylim(0, 3.6)
    ax2.set_yticks([0, 1, 2, 3])
    ax2.set_ylabel("scenes rendered", color=t["ink2"])
    ax2.set_xticks([0, BOUNDS[0] - BAND, 1 / 3, BOUNDS[0] + BAND, 0.5, BOUNDS[1] - BAND, 2 / 3, BOUNDS[1] + BAND, 1])
    ax2.set_xticklabels(["0", ".283", "1/3", ".383", ".5", ".617", "2/3", ".717", "1"])
    ax2.set_xlabel("view position v", color=t["ink2"])
    ax2.annotate("naive: all scenes, always", xy=(1.0, 3), xytext=(1.02, 3), xycoords=("axes fraction", "data"),
                 va="center", ha="left", fontsize=9.5, color=t["ink2"], annotation_clip=False)
    ax2.annotate("lenticulAR: visible only", xy=(1.0, 1), xytext=(1.02, 1), xycoords=("axes fraction", "data"),
                 va="center", ha="left", fontsize=9.5, color=t["ink2"], annotation_clip=False)
    ax2.plot([1.005], [3], marker="o", markersize=7, color=t["neutral"], markeredgecolor=t["surface"], markeredgewidth=2,
             clip_on=False, transform=ax2.get_yaxis_transform())
    ax2.plot([1.005], [1], marker="o", markersize=7, color=t["accent"], markeredgecolor=t["surface"], markeredgewidth=2,
             clip_on=False, transform=ax2.get_yaxis_transform())
    save(fig, "view-zones", mode)


def fig_prism_cross_section(mode):
    t = THEMES[mode]
    K, count = 3, 3
    angles = [0, 30, 60, 90, 120]
    notes = ["at rest: face A", "gaps open", "half-way", "gaps open", "at rest: face B"]
    face_colors = [t["scene"][0], t["scene"][1], t["faceC"]]
    gap_color = t["muted"]
    fig, axes = plt.subplots(1, len(angles), figsize=(10.5, 3.55), facecolor=t["surface"])
    title(fig, t, "Top view of three neighbouring prisms during one A → B step",
          "Viewer below, looking up (orthographic). The bar under each panel is what that part of the screen shows.",
          y=0.975)
    fig.subplots_adjust(left=0.01, right=0.99, top=0.76, bottom=0.1, wspace=0.08)
    R = 1 / (2 * math.sin(math.pi / K))
    n = 3000
    for ax, deg, note in zip(axes, angles, notes):
        th = math.radians(deg)
        ax.set_facecolor(t["surface"])
        ax.set_xlim(-0.08, count + 0.08)
        ax.set_ylim(-1.32, 0.66)
        ax.set_aspect("equal")
        ax.axis("off")
        ax.set_title(f"{deg}°  ·  {note}", fontsize=10.5, color=t["ink"], pad=6)
        for j in range(count):
            cx = j + 0.5
            # vertices sit half-way between face normals; +z (towards the viewer) is drawn downwards
            verts = [
                (cx + R * math.sin((f + 0.5) * 2 * math.pi / K - th), -R * math.cos((f + 0.5) * 2 * math.pi / K - th))
                for f in range(K)
            ]
            ax.add_patch(Polygon(verts, closed=True, facecolor=t["prismFill"], edgecolor="none"))
            for f in range(K):
                p0, p1 = verts[(f - 1) % K], verts[f]
                ax.plot([p0[0], p1[0]], [p0[1], p1[1]], color=face_colors[f], linewidth=3.2, solid_capstyle="butt")
            ax.plot([cx], [0], marker="o", markersize=2.5, color=t["muted"])
        # what the viewer sees, run-length encoded
        y0, h = -0.86, 0.2
        faces = [cast_screen((k + 0.5) / n * count, count, th) for k in range(n)]
        k = 0
        while k < n:
            f = faces[k]
            e = k
            while e < n and faces[e] == f:
                e += 1
            ax.add_patch(Rectangle((k / n * count, y0), (e - k) / n * count, h, linewidth=0,
                                   facecolor=gap_color if f is None else face_colors[f]))
            k = e
        for j in range(1, count):
            ax.plot([j, j], [y0 - 0.05, y0 + h + 0.05], color=t["surface"], linewidth=1.6)
        mid = faces[n // 3: 2 * n // 3]  # the middle prism's strip
        cov_a = sum(f == 0 for f in mid) / len(mid)
        cov_b = sum(f == 1 for f in mid) / len(mid)
        gap = 1 - cov_a - cov_b
        parts = [f"A {cov_a * 100:.0f}%" if cov_a > 0.005 else None, f"B {cov_b * 100:.0f}%" if cov_b > 0.005 else None,
                 f"gap {gap * 100:.1f}%" if gap > 0.0005 else None]
        ax.text(count / 2, y0 - 0.12, " · ".join(p for p in parts if p), ha="center", va="top", fontsize=9.5,
                color=t["ink2"])
    handles = [plt.Line2D([0], [0], color=c, linewidth=3.2) for c in face_colors] + [
        Rectangle((0, 0), 1, 1, facecolor=gap_color, linewidth=0)
    ]
    fig.legend(handles, ["face A · outgoing scene", "face B · incoming scene", "face C · spare", "gap (backing)"],
               loc="lower center", bbox_to_anchor=(0.5, 0.0), ncol=4, frameon=False, fontsize=9.5, labelcolor=t["ink2"],
               handlelength=1.8)
    save(fig, "prism-cross-section", mode)


def fig_coverage(mode, ver):
    t = THEMES[mode]
    rows = ver["coverage"]
    fig, ax = plt.subplots(figsize=(8.2, 4.5), facecolor=t["surface"])
    title(fig, t, "Shader output matches the geometric reference",
          f"Share of each strip showing face A, face B or the gap · lines: CPU reference · dots: GPU pixels "
          f"(worst error {ver['coverageWorstAbsError'] * 100:.2f} %)")
    fig.subplots_adjust(left=0.085, right=0.74, top=0.8, bottom=0.13)
    style_axes(ax, t)
    xs = [r["angleDeg"] for r in rows]
    series = [("A", t["scene"][0], "face A (outgoing)"), ("B", t["scene"][1], "face B (incoming)"),
              ("gap", t["neutral"], "gap")]
    # dense analytic curves from the same geometry
    dense = [i / 2 for i in range(241)]

    def coverage(deg):
        th = math.radians(deg)
        a = b = 0
        n = 1500
        for k in range(n):
            f = cast_screen(1 + (k + 0.5) / n, 3, th)
            a += f == 0
            b += f == 1
        return a / n, b / n, 1 - (a + b) / n

    curves = [coverage(d) for d in dense]
    handles = []
    for idx, (key, color, label) in enumerate(series):
        ax.plot(dense, [c[idx] * 100 for c in curves], color=color, linewidth=2)
        ax.plot(xs, [r["gpu"][key] * 100 for r in rows], linestyle="none", marker="o", markersize=7.5,
                color=color, markeredgecolor=t["surface"], markeredgewidth=2)
        handles.append(plt.Line2D([0], [0], color=color, linewidth=2, marker="o", markersize=7.5,
                                  markeredgecolor=t["surface"], markeredgewidth=2))
    # direct labels where the curves are well apart (never stacked at a shared end)
    ax.text(3, 88, "face A · outgoing", ha="left", va="top", fontsize=9.5, color=t["ink2"])
    ax.text(117, 88, "face B · incoming", ha="right", va="top", fontsize=9.5, color=t["ink2"])
    ax.text(60, 6, "gap between prisms", ha="center", va="bottom", fontsize=9.5, color=t["ink2"])
    ax.set_xlim(0, 120)
    ax.set_ylim(-3, 108)
    ax.set_xticks([0, 30, 60, 90, 120])
    ax.set_xticklabels(["0°", "30°", "60°", "90°", "120°"])
    ax.set_yticks([0, 25, 50, 75, 100])
    ax.set_yticklabels(["0", "25", "50", "75", "100 %"])
    ax.set_xlabel("prism rotation within one step", color=t["ink2"])
    ax.legend(handles, [lab for _, _, lab in series], loc="upper left", bbox_to_anchor=(1.01, 1.0), frameon=False,
              fontsize=9.5, labelcolor=t["ink2"], handlelength=2.2)
    save(fig, "coverage", mode)


def fig_render_cost(mode, bench):
    t = THEMES[mode]
    s = bench["series"]
    env = bench["environment"]
    fig, ax = plt.subplots(figsize=(10, 4.4), facecolor=t["surface"])
    lazy_rest = bench["summary"]["lazy"]["rest"]["medianMs"]
    always_rest = bench["summary"]["always"]["rest"]["medianMs"]
    renderer = env["renderer"]
    device = "SwiftShader (software WebGL)" if "SwiftShader" in renderer else renderer[:60]
    title(fig, t, "Frame time across the view range",
          f"{device} · {env['viewport'][0]}×{env['viewport'][1]} · "
          f"median of {env['repeats']} frames per point, timed through a 1-px readback")
    fig.subplots_adjust(left=0.07, right=0.72, top=0.8, bottom=0.13)
    style_axes(ax, t)
    for b in BOUNDS:
        ax.axvspan(b - BAND, b + BAND, color=t["band"], linewidth=0, zorder=0)
        ax.text(b, 1.0, "band", transform=ax.get_xaxis_transform(), ha="center", va="bottom", fontsize=9, color=t["muted"])
    labels = {
        "always": f"naive: every scene, every frame\n{always_rest:,.0f} ms at rest",
        "lazy": f"lenticulAR: visible scenes only\n{lazy_rest:,.0f} ms at rest",
    }
    for key, color in (("always", t["neutral"]), ("lazy", t["accent"])):
        xs = [p["v"] for p in s[key]]
        ys = [p["ms"] for p in s[key]]
        ax.plot(xs, ys, color=color, linewidth=2, drawstyle="steps-mid")  # one measurement per position
        ax.plot([xs[-1]], [ys[-1]], marker="o", markersize=7.5, color=color, markeredgecolor=t["surface"], markeredgewidth=2)
        ax.annotate(labels[key], xy=(xs[-1], ys[-1]), xytext=(xs[-1] + 0.03, ys[-1]), va="center", ha="left",
                    fontsize=9.5, color=t["ink2"], annotation_clip=False, linespacing=1.4)
    ax.set_xlim(0, 1)
    top = max(p["ms"] for p in s["always"]) * 1.15
    ax.set_ylim(0, top)
    ax.set_ylabel("ms per frame", color=t["ink2"])
    ax.set_xlabel("view position v", color=t["ink2"])
    ax.set_xticks([0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1])
    ax.set_xticklabels(["0", ".25", "1/3", ".5", "2/3", ".75", "1"])
    save(fig, "render-cost", mode)


def main():
    import argparse

    global PREVIEW_DIR
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preview", metavar="DIR", help="also write PNG copies to DIR")
    PREVIEW_DIR = ap.parse_args().preview
    OUT.mkdir(parents=True, exist_ok=True)
    ver_path, bench_path = OUT / "verification.json", OUT / "benchmark.json"
    ver = json.loads(ver_path.read_text()) if ver_path.exists() else None
    bench = json.loads(bench_path.read_text()) if bench_path.exists() else None
    for mode in ("light", "dark"):
        fig_view_zones(mode)
        fig_prism_cross_section(mode)
        if ver:
            fig_coverage(mode, ver)
        if bench:
            fig_render_cost(mode, bench)


if __name__ == "__main__":
    main()
