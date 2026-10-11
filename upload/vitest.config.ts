import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two seams (see the spec, issue #33):
//  - server: the service's HTTP boundary, with the auth session endpoint and
//    ResourceSpace faked as real HTTP servers.
//  - web: the page's components, with the service's answers faked.
export default defineConfig({
  test: {
    projects: [
      {
        test: { name: "server", environment: "node", include: ["server/**/*.test.ts"] },
      },
      {
        // How the container is deployed: docker-compose.yaml and the Dockerfile.
        test: { name: "deploy", environment: "node", include: ["deploy/**/*.test.ts"] },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          include: ["web/**/*.test.tsx"],
          setupFiles: ["web/test-setup.ts"],
        },
      },
    ],
  },
});
