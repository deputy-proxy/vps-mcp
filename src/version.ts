import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as { version?: unknown };

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("The vps-mcp package manifest does not contain a valid version");
}

export const VERSION = packageMetadata.version;
