import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Draggable } from "gsap/Draggable";
import { InertiaPlugin } from "gsap/InertiaPlugin";
import { Flip } from "gsap/Flip";
import { SplitText } from "gsap/SplitText";
import ScrambleText from "gsap/ScrambleTextPlugin";

gsap.registerPlugin(ScrollTrigger, Draggable, InertiaPlugin, Flip, SplitText, ScrambleText);

export { gsap, ScrollTrigger, Draggable, InertiaPlugin, Flip, SplitText, ScrambleText };
