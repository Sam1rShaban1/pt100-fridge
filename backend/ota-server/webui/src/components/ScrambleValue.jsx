import { useEffect, useRef } from "react";
import { gsap, ScrambleText } from "../lib/gsapSetup.js";

export default function ScrambleValue({ value, className }) {
  const ref = useRef(null);
  const prev = useRef(value);

  useEffect(() => {
    if (prev.current === value) return;
    const tween = gsap.to(ref.current, {
      duration: 0.6,
      scrambleText: { text: value, chars: "0123456789.", speed: 0.4, revealDelay: 0.05 },
      ease: "none",
    });
    prev.current = value;
    return () => tween.kill();
  }, [value]);

  return (
    <span ref={ref} className={className}>
      {value}
    </span>
  );
}
