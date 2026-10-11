import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The app is served by the upload service under /upload/ (see server/app.ts).
export default defineConfig({
  root: "web",
  base: "/upload/",
  plugins: [react(), tailwindcss()],
  build: { outDir: "../dist/web", emptyOutDir: true },
});
