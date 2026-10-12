// Checks on how the service is deployed (docker-compose.yaml at the repo root
// and upload/Dockerfile): the container hardening and network isolation from
// issue #23, and that ResourceSpace keeps every path but /upload.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = path.resolve(import.meta.dirname, "..", "..");
const compose = parse(readFileSync(path.join(root, "docker-compose.yaml"), "utf8")) as {
  services: Record<string, Record<string, unknown>>;
};
const dockerfile = readFileSync(path.join(root, "upload", "Dockerfile"), "utf8");

const upload = compose.services.upload!;
const networksOf = (name: string) => compose.services[name]?.networks as string[];
const labelsOf = (name: string) => compose.services[name]?.labels as string[];

describe("the upload container", () => {
  it("is built from upload/", () => {
    expect(upload.build).toBe("./upload");
  });

  it("joins only the Traefik network and the network ResourceSpace is on", () => {
    expect([...networksOf("upload")].sort()).toEqual(["dokploy-network", "frontend"]);
    expect(networksOf("resourcespace")).toContain("frontend");
  });

  it.each(["mariadb", "clip", "faces"])("shares no network with %s", (other) => {
    const shared = networksOf("upload").filter((n) => networksOf(other).includes(n));
    expect(shared).toEqual([]);
  });

  it("runs as a non-root user", () => {
    const users = [...dockerfile.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]!);
    const last = users.at(-1);
    expect(last).toBeDefined();
    const [uid] = last!.split(":");
    expect(uid).toMatch(/^\d+$/);
    expect(Number(uid)).toBeGreaterThan(0);
    expect(upload.user).toBeUndefined(); // compose must not override it
  });

  it("has a read-only root filesystem, with only staging and a small /tmp writable", () => {
    expect(upload.read_only).toBe(true);
    expect(upload.tmpfs).toEqual([expect.stringMatching(/^\/tmp:size=\d+m,.*noexec/)]);
    const volumes = upload.volumes as { type: string; target: string; source: string }[];
    expect(volumes.map((v) => v.target)).toEqual(["/staging"]);
  });

  it("puts staging on a host path that must be set, never a default on the root disk", () => {
    const [staging] = upload.volumes as { type: string; source: string }[];
    expect(staging!.type).toBe("bind");
    expect(staging!.source).toMatch(/^\$\{UPLOAD_STAGING_PATH:\?/);
  });

  it("drops every capability and cannot gain privileges", () => {
    expect(upload.cap_drop).toEqual(["ALL"]);
    expect(upload.cap_add).toBeUndefined();
    expect(upload.privileged).toBeUndefined();
    expect(upload.security_opt).toContain("no-new-privileges:true");
  });

  it("has memory, CPU and process-count limits", () => {
    expect(upload.mem_limit).toBeTruthy();
    expect(upload.cpus).toBeTruthy();
    expect(upload.pids_limit).toBeGreaterThan(0);
  });

  // The host has no default log rotation, and the log is on the root disk (#60).
  it("keeps its log to a bounded size", () => {
    expect(upload.logging).toEqual({ driver: "json-file", options: { "max-size": "20m", "max-file": "5" } });
  });

  it("holds no database secrets and no ResourceSpace secret but the upload-service key", () => {
    const env = (upload.environment as string[]).join("\n");
    expect(env).not.toMatch(/MYSQL|MARIADB|SCRAMBLE|PASSWORD/);
    expect((upload.environment as string[]).filter((e) => /KEY|SECRET|TOKEN/.test(e))).toEqual([
      "RS_UPLOADER_API_KEY=${RS_UPLOADER_API_KEY:-}",
    ]);
  });

  // A required variable (`:?`) that is unset fails the whole compose deploy,
  // which blocks every other service's deploy too. Only the staging path may
  // do that (ADR 0004); a missing key fails closed inside the service instead.
  it("requires no environment variable to be set", () => {
    const env = (upload.environment as string[]).join("\n");
    expect(env).not.toContain(":?");
  });
});

describe("routing on the media host name", () => {
  it("sends only /upload and below to the upload service, ahead of ResourceSpace", () => {
    const labels = labelsOf("upload");
    expect(labels).toContain(
      "traefik.http.routers.media-upload.rule=Host(`${DOMAIN_NAME}`) && (Path(`/upload`) || PathPrefix(`/upload/`))",
    );
    expect(labels).toContain("traefik.http.routers.media-upload.priority=100");
    expect(labels).toContain("traefik.docker.network=dokploy-network");
  });

  it("leaves ResourceSpace serving every other path on the host name", () => {
    expect(labelsOf("resourcespace")).toContain("traefik.http.routers.resourcespace.rule=Host(`${DOMAIN_NAME}`)");
    expect(labelsOf("resourcespace").some((l) => l.includes(".priority="))).toBe(false);
  });
});
