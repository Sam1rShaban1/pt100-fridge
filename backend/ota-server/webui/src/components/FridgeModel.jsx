import { useEffect, useRef } from "react";
import { createModel3D } from "../lib/fridgeModel.js";
import { gsap, Draggable } from "../lib/gsapSetup.js";

export default function FridgeModel({ room, latest, colorScale, selectedSensor, onSelect }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const modelRef = useRef(null);
  const yawRef = useRef(-0.6);

  // Live refs so the rAF loop always reads fresh props.
  const roomRef = useRef(room);
  const latestRef = useRef(latest);
  const cfgRef = useRef({ color_scale: colorScale, stale_after_s: 15 });
  const selRef = useRef(selectedSensor);
  const onSelectRef = useRef(onSelect);
  roomRef.current = room;
  latestRef.current = latest;
  cfgRef.current = { color_scale: colorScale, stale_after_s: 15 };
  selRef.current = selectedSensor;
  onSelectRef.current = onSelect;

  useEffect(() => {
    const canvas = canvasRef.current;
    const model = createModel3D(canvas);
    modelRef.current = model;
    let raf;
    let dragging = false;

    const loop = (now) => {
      if (!dragging) yawRef.current += 0.0016;
      model.render(roomRef.current, latestRef.current, cfgRef.current, selRef.current, now / 1000, yawRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const proxy = document.createElement("div");
    let yaw0 = 0;
    const drag = Draggable.create(proxy, {
      type: "x",
      inertia: true,
      onPress() {
        dragging = true;
        yaw0 = yawRef.current - this.x * 0.006;
      },
      onDrag() {
        yawRef.current = yaw0 + this.x * 0.006;
      },
      onThrowUpdate() {
        yawRef.current = yaw0 + this.x * 0.006;
      },
      onRelease() {
        if (!this.tween) dragging = false;
      },
      onThrowComplete() {
        dragging = false;
      },
    })[0];

    const ro = new ResizeObserver(() => {
      // Resize handled inside model.render via parent size.
    });
    if (wrapRef.current) ro.observe(wrapRef.current);

    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const id = model.pick(e.clientX - rect.left, e.clientY - rect.top);
      if (id) onSelectRef.current(id);
    };
    canvas.addEventListener("click", onClick);

    return () => {
      cancelAnimationFrame(raf);
      drag.kill();
      ro.disconnect();
      canvas.removeEventListener("click", onClick);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative h-full w-full cursor-grab active:cursor-grabbing"
      title="Drag to orbit the cold room"
    >
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}
