import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import LenticularEngine from "./engine/LenticularEngine";
import * as viewZones from "./engine/viewZones";
import * as prismGeometry from "./engine/prismGeometry";
import { generateDemoScenes } from "./demo/demoScenes";
import Hud from "./Hud";
import ControlPanel from "./ControlPanel";

const { createViewLayout } = viewZones;

/** Query-string options, e.g. ?tracking=pointer&prisms=48&mapping=mask&hud=1 */
function readParams() {
  const q = new URLSearchParams(window.location.search);
  const num = (k, d) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
  const str = (k, d) => q.get(k) ?? d;
  const capture = q.get("capture") === "1";
  return {
    capture,
    tracking: str("tracking", capture ? "manual" : null),
    v: num("v", 0.5),
    hud: q.has("hud") ? q.get("hud") !== "0" : !capture,
    panel: q.has("panel") ? q.get("panel") !== "0" : false,
    count: num("prisms", 24),
    mapping: str("mapping", "print"),
    stagger: num("stagger", 0),
    band: num("band", 0.05),
    shading: num("shading", 0.45),
    parallax: num("parallax", 0.6),
    viewCone: num("cone", 40),
    easing: str("easing", "smoothstep"),
    scheduling: str("scheduling", "lazy"),
    samples: num("samples", 4),
    debugFaces: q.get("debug") === "faces",
    pixelRatio: q.has("dpr") ? num("dpr", 1) : null,
  };
}

function engineOptions(p) {
  return {
    transitionHalfWidth: p.band,
    easing: p.easing,
    viewConeDeg: p.viewCone,
    parallax: p.parallax,
    scheduling: p.scheduling,
    smoothingMs: p.capture ? 0 : 70,
    preserveDrawingBuffer: p.capture,
    pixelRatio: p.pixelRatio,
    prism: {
      count: p.count,
      mapping: p.mapping,
      stagger: p.stagger,
      shading: p.shading,
      samples: p.samples,
      debugFaces: p.debugFaces,
    },
  };
}

function App() {
  const params = useMemo(readParams, []);
  const container = useRef(null);
  const engineRef = useRef(null);
  const hudRef = useRef(null);
  const [started, setStarted] = useState(Boolean(params.tracking));
  const [tracking, setTracking] = useState(params.tracking === "face" ? "face" : "pointer");
  const [status, setStatus] = useState(null);
  const [showHud, setShowHud] = useState(params.hud);
  const [showPanel, setShowPanel] = useState(params.panel);

  const scenes = useMemo(() => generateDemoScenes(), []);
  const sceneMeta = useMemo(
    () => scenes.map((s, k) => ({ label: s.label, accent: s.accent, short: String.fromCharCode(65 + k) })),
    [scenes]
  );
  const [layout, setLayout] = useState(() =>
    createViewLayout({ sceneCount: scenes.length, transitionHalfWidth: params.band })
  );

  useEffect(() => {
    const engine = new LenticularEngine({
      container: container.current,
      scenes,
      ...engineOptions(params),
      onFrame: (stats) => hudRef.current?.update(stats),
      onStatus: (s) => {
        if (s.type === "tracking" && engine.tracker?.source === "face") {
          setStatus(s.tracking ? null : "Looking for your face…");
        }
      },
    });
    engineRef.current = engine;

    if (params.capture) {
      // Deterministic hooks for scripts/capture_results.py: no animation loop,
      // the harness sets a view position and renders exactly one frame.
      (async () => {
        await engine.load();
        await engine.setTracker("manual", { v: params.v });
        window.lenticulAR = {
          engine,
          frame(v, vy = 0.5) {
            engine.setViewPosition(v, vy);
            return engine.renderFrame(performance.now());
          },
          setOptions: (patch) => engine.setOptions(patch),
          // the CPU reference the GPU output is checked against
          math: { ...viewZones, ...prismGeometry },
        };
        window.lenticulAR.frame(params.v);
        window.lenticulAR.ready = true;
      })();
    } else if (params.tracking) {
      engine.start(params.tracking, { v: params.v }).catch((err) => {
        setStatus(err.message || String(err));
        setTracking("pointer");
        engine.start("pointer");
      });
    } else {
      // render a still behind the landing screen
      engine.load().then(() => engine.renderFrame());
    }

    return () => {
      engine.dispose();
      engineRef.current = null;
      if (window.lenticulAR?.engine === engine) delete window.lenticulAR;
    };
  }, [params, scenes]);

  const startWith = useCallback(async (kind) => {
    const engine = engineRef.current;
    if (!engine) return;
    setStarted(true);
    setTracking(kind);
    setStatus(kind === "face" ? "Starting the camera…" : null);
    try {
      await engine.start(kind); // face tracking then reports "looking for your face" via onStatus
      if (kind !== "face") setStatus(null);
    } catch (err) {
      console.warn("lenticulAR: tracker failed, falling back to pointer", err);
      setTracking("pointer");
      setStatus(
        `Camera unavailable (${err?.message || err?.name || "permission denied"}) — using mouse / touch instead.`
      );
      await engine.start("pointer");
      setTimeout(() => setStatus(null), 6000);
    }
  }, []);

  const switchTracking = useCallback(
    (kind) => {
      if (kind === tracking && engineRef.current?.tracker) return;
      startWith(kind);
    },
    [tracking, startWith]
  );

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLInputElement) return;
      const engine = engineRef.current;
      if (e.key === "h" || e.key === "H") setShowHud((s) => !s);
      else if (e.key === "c" || e.key === "C") setShowPanel((s) => !s);
      else if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) document.exitFullscreen?.();
        else document.documentElement.requestFullscreen?.().catch(() => {});
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && engine?.tracker?.source === "pointer") {
        const step = (e.shiftKey ? 0.002 : 0.01) * (e.key === "ArrowLeft" ? -1 : 1);
        engine.setViewPosition(engine.tracker.v + step);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onPanelChange = useCallback(
    (patch) => {
      const engine = engineRef.current;
      if (!engine) return;
      try {
        engine.setOptions(patch);
        if ("transitionHalfWidth" in patch) {
          setLayout(createViewLayout({ sceneCount: scenes.length, transitionHalfWidth: patch.transitionHalfWidth }));
        }
      } catch (err) {
        setStatus(err.message);
        setTimeout(() => setStatus(null), 4000);
      }
    },
    [scenes.length]
  );

  return (
    <>
      <div id="container" ref={container} />

      {!started && (
        <div id="landing">
          <h1>
            lenticul<span>AR</span>
          </h1>
          <p className="lede">A lenticular print, faked with rotating prisms.</p>
          <p>
            Three depth-mapped scenes sit behind your screen. Where you stand picks the one you see —
            move across and a row of prisms turns to mask one scene out and the next one in, just
            like tilting a lenticular card. Only the scene you can see is rendered; two while the
            prisms turn.
          </p>
          <div className="actions">
            <button className="primary" onClick={() => startWith("face")}>
              Use camera (face tracking)
            </button>
            <button onClick={() => startWith("pointer")}>Use mouse / touch</button>
          </div>
          <p className="fine">
            Face tracking runs entirely in your browser (MindAR + MediaPipe); no video leaves the device.
          </p>
        </div>
      )}

      {started && !params.capture && !showPanel && (
        <button className="panel-toggle" onClick={() => setShowPanel(true)}>
          Controls
        </button>
      )}

      {started && showPanel && !params.capture && (
        <ControlPanel
          initial={{
            count: params.count,
            mapping: params.mapping,
            band: params.band,
            stagger: params.stagger,
            shading: params.shading,
            parallax: params.parallax,
            viewCone: params.viewCone,
            easing: params.easing,
            scheduling: params.scheduling,
            debugFaces: params.debugFaces,
          }}
          tracking={tracking}
          onTracking={switchTracking}
          onChange={onPanelChange}
          onClose={() => setShowPanel(false)}
        />
      )}

      {showHud && (started || params.capture) && (
        <Hud ref={hudRef} layout={layout} scenes={sceneMeta} showFps={!params.capture} />
      )}

      {status && <div className="status">{status}</div>}
    </>
  );
}

export default App;
