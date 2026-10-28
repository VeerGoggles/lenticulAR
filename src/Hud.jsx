import { forwardRef, useImperativeHandle, useRef } from "react";

/**
 * Debug strip: the view range with its rest zones and transition bands, a
 * marker at the viewer's current position, and what the renderer did this
 * frame. Updated imperatively from the engine's onFrame (no React render per
 * frame).
 */
const Hud = forwardRef(function Hud({ layout, scenes, showFps = true }, ref) {
  const markerRef = useRef(null);
  const zoneRefs = useRef([]);
  const vRef = useRef(null);
  const stateRef = useRef(null);
  const angleRef = useRef(null);
  const passesRef = useRef(null);
  const fpsRef = useRef(null);
  const lastT = useRef(0);
  const dtAvg = useRef(null);

  useImperativeHandle(ref, () => ({
    update(stats) {
      if (!stats) return;
      if (markerRef.current) markerRef.current.style.left = `${(stats.v * 100).toFixed(3)}%`;
      zoneRefs.current.forEach((el, k) => {
        if (el) el.classList.toggle("on", stats.active.includes(k));
      });
      const name = (k) => scenes[k]?.short ?? String.fromCharCode(65 + k);
      if (vRef.current) vRef.current.textContent = stats.v.toFixed(3);
      if (stateRef.current) {
        stateRef.current.textContent =
          stats.zone === "rest"
            ? `scene ${name(stats.from)} at rest`
            : `${name(stats.from)} → ${name(stats.to)} · ${(stats.progress * 100).toFixed(0)}%`;
      }
      if (angleRef.current) angleRef.current.textContent = `${stats.stepAngleDeg.toFixed(0)}°`;
      if (passesRef.current) {
        passesRef.current.textContent = `${stats.scenePasses} scene${stats.scenePasses === 1 ? "" : "s"}${
          stats.composite ? " + prisms" : ""
        }`;
        passesRef.current.dataset.n = String(stats.scenePasses);
      }
      if (fpsRef.current) {
        const now = performance.now();
        const dt = lastT.current ? now - lastT.current : 0;
        lastT.current = now;
        if (dt > 0 && dt < 1000) {
          dtAvg.current = dtAvg.current == null ? dt : dtAvg.current * 0.92 + dt * 0.08;
          fpsRef.current.textContent = `${(1000 / dtAvg.current).toFixed(0)} fps`;
        }
      }
    },
  }));

  // rest zones and transition bands across 0..1
  const pieces = [];
  let cursor = 0;
  layout.bands.forEach((band) => {
    pieces.push({ kind: "rest", scene: band.from, start: cursor, end: band.start });
    pieces.push({ kind: "band", from: band.from, to: band.to, start: band.start, end: band.end });
    cursor = band.end;
  });
  pieces.push({ kind: "rest", scene: layout.sceneCount - 1, start: cursor, end: 1 });

  return (
    <div className="hud" aria-hidden="true">
      <div className="hud-bar">
        {pieces.map((p, i) =>
          p.kind === "rest" ? (
            <div
              key={i}
              ref={(el) => (zoneRefs.current[p.scene] = el)}
              className="hud-zone"
              style={{
                left: `${p.start * 100}%`,
                width: `${(p.end - p.start) * 100}%`,
                "--accent": scenes[p.scene]?.accent ?? "#888",
              }}
            >
              <span>{scenes[p.scene]?.label ?? `Scene ${p.scene + 1}`}</span>
            </div>
          ) : (
            <div
              key={i}
              className="hud-band"
              style={{
                left: `${p.start * 100}%`,
                width: `${(p.end - p.start) * 100}%`,
                "--a": scenes[p.from]?.accent ?? "#888",
                "--b": scenes[p.to]?.accent ?? "#888",
              }}
            />
          )
        )}
        <div className="hud-marker" ref={markerRef} />
      </div>
      <div className="hud-stats">
        <span>
          v <b ref={vRef}>0.500</b>
        </span>
        <span ref={stateRef}>—</span>
        <span>
          prism step <b ref={angleRef}>0°</b>
        </span>
        <span>
          rendering <b ref={passesRef} className="hud-passes">1 scene</b>
        </span>
        {showFps && (
          <span ref={fpsRef} className="hud-fps">
            — fps
          </span>
        )}
      </div>
    </div>
  );
});

export default Hud;
