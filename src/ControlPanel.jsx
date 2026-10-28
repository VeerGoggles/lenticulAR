import { useState } from "react";

function Range({ label, value, min, max, step, format = (v) => v, onChange }) {
  return (
    <label className="ctl">
      <span className="ctl-label">
        {label}
        <output>{format(value)}</output>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Segmented({ label, value, options, onChange }) {
  return (
    <div className="ctl">
      <span className="ctl-label">{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            className={value === v ? "on" : ""}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Live tuning for the prism mask and the view bands. Every change goes
 * straight to engine.setOptions(); nothing here is needed to use the engine.
 */
export default function ControlPanel({ initial, tracking, onChange, onTracking, onClose }) {
  const [o, setO] = useState(initial);
  const set = (key, value, patch) => {
    setO((prev) => ({ ...prev, [key]: value }));
    onChange(patch);
  };
  const pct = (v) => `±${(v * 100).toFixed(1)}%`;

  return (
    <aside className="panel">
      <header>
        <strong>lenticulAR</strong>
        <button type="button" className="panel-close" onClick={onClose} aria-label="Hide controls">
          ×
        </button>
      </header>

      <Segmented
        label="Tracking"
        value={tracking}
        options={[
          ["face", "Camera"],
          ["pointer", "Mouse / touch"],
        ]}
        onChange={onTracking}
      />
      <Range
        label="Prisms across"
        value={o.count}
        min={4}
        max={96}
        step={1}
        onChange={(v) => set("count", v, { prism: { count: v } })}
      />
      <Segmented
        label="Face mapping"
        value={o.mapping}
        options={[
          ["print", "Print"],
          ["mask", "Mask"],
        ]}
        onChange={(v) => set("mapping", v, { prism: { mapping: v } })}
      />
      <Range
        label="Transition band"
        value={o.band}
        min={0.01}
        max={0.15}
        step={0.005}
        format={pct}
        onChange={(v) => set("band", v, { transitionHalfWidth: v })}
      />
      <Range
        label="Sweep (stagger)"
        value={o.stagger}
        min={0}
        max={1.5}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set("stagger", v, { prism: { stagger: v } })}
      />
      <Range
        label="Face shading"
        value={o.shading}
        min={0}
        max={1}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set("shading", v, { prism: { shading: v } })}
      />
      <Range
        label="Parallax"
        value={o.parallax}
        min={0}
        max={1.5}
        step={0.05}
        format={(v) => v.toFixed(2)}
        onChange={(v) => set("parallax", v, { parallax: v })}
      />
      <Range
        label="View cone (camera)"
        value={o.viewCone}
        min={16}
        max={80}
        step={1}
        format={(v) => `${v}°`}
        onChange={(v) => set("viewCone", v, { viewConeDeg: v })}
      />
      <Segmented
        label="Easing"
        value={o.easing}
        options={[
          ["linear", "Linear"],
          ["smoothstep", "Smooth"],
          ["smootherstep", "Smoother"],
        ]}
        onChange={(v) => set("easing", v, { easing: v })}
      />
      <Segmented
        label="Scheduling"
        value={o.scheduling}
        options={[
          ["lazy", "Visible only"],
          ["always", "All scenes"],
        ]}
        onChange={(v) => set("scheduling", v, { scheduling: v })}
      />
      <label className="ctl ctl-check">
        <input
          type="checkbox"
          checked={o.debugFaces}
          onChange={(e) => set("debugFaces", e.target.checked, { prism: { debugFaces: e.target.checked } })}
        />
        <span>Show face ids (A red · B green · gap black)</span>
      </label>
      <p className="panel-keys">
        <kbd>H</kbd> HUD · <kbd>C</kbd> controls · <kbd>←</kbd>/<kbd>→</kbd> nudge · <kbd>F</kbd> fullscreen
      </p>
    </aside>
  );
}
