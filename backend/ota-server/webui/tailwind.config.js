/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#070b11",
        panel: "#0d131c",
        panel2: "#111927",
        line: "rgba(148,163,184,0.14)",
        linestrong: "rgba(148,163,184,0.32)",
        mut: "#8aa0b4",
        text: "#e6edf5",
        ice: "#7dd3fc",
        frost: "#38bdf8",
        cold: "#22d3ee",
        warn: "#fbbf24",
        alarm: "#f87171",
      },
      fontFamily: {
        sans: ["Satoshi", "Cabinet Grotesk", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      borderRadius: {
        xl: "16px",
        "2xl": "22px",
      },
      maxWidth: {
        shell: "1480px",
      },
    },
  },
  plugins: [],
};
