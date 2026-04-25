import type { Config } from "tailwindcss";

// Design tokens for The Lab. Dark "lab notebook" theme — distinct from
// the kit's light/paper default but keeps the same indigo CTA accent so
// it doesn't feel like a different product.
export default {
  content: ["./src/lab/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary:  "#0F1117",
          surface:  "#1A1D27",
          elevated: "#22263A",
        },
        border: {
          DEFAULT: "#2E3347",
        },
        text: {
          primary: "#E8EAF0",
          muted:   "#7B82A0",
        },
        accent: {
          spark:    "#F59E0B",
          develop:  "#3B82F6",
          ready:    "#10B981",
          promoted: "#8B5CF6",
          primary:  "#6366F1",
        },
      },
      fontFamily: {
        display: ['"DM Mono"', "ui-monospace", "monospace"],
        sans:    ['"IBM Plex Sans"', "ui-sans-serif", "system-ui"],
      },
      backgroundImage: {
        "dot-grid":
          "radial-gradient(circle at 1px 1px, rgba(46, 51, 71, 0.6) 1px, transparent 0)",
      },
      backgroundSize: {
        "dot-24": "24px 24px",
      },
    },
  },
} satisfies Config;
