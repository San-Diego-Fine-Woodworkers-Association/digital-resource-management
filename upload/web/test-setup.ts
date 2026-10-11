import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => cleanup());

// jsdom has no object URLs; the page uses them to preview a chosen photo.
if (typeof URL.createObjectURL !== "function") {
  URL.createObjectURL = () => "blob:test-preview";
  URL.revokeObjectURL = () => {};
}
