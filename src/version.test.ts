import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { VERSION } from "./version.js";

it("uses the package manifest version as the single source of truth", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  expect(VERSION).toBe(manifest.version);
});
