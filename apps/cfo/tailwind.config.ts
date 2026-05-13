import type { Config } from "tailwindcss";

// Light "ledger paper" theme — indigo accent.
export default {
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        bg: {
          primary:  "#F8FAFC",
          surface:  "#FFFFFF",
          elevated: "#F1F5F9",
        },
        border: {
          DEFAULT: "#E2E8F0",
          strong:  "#CBD5E1",
        },
        text: {
          primary: "#0F172A",
          muted:   "#64748B",
          subtle:  "#94A3B8",
        },
        accent: {
          primary:  "#4F46E5",
          success:  "#059669",
          warn:     "#D97706",
          danger:   "#DC2626",
        },
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
} satisfies Config;
