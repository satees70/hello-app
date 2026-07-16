import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#F7F6F2",
        card: "#FFFFFF",
        income: "#2E5E4E",
        primary: "#2E5E4E",
        expense: "#B5443C",
        ink: "#1D2A24",
        muted: "#6B7A72",
        line: "#E4E7E3",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
