import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// PROTOTYPE, THROWAWAY (wayfinder map: Member Media Upload).
export default defineConfig({ plugins: [react(), tailwindcss()] });
