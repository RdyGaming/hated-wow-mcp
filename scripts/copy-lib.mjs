// Copies the ported wow.export CommonJS code next to the compiled output.
// tsc only emits TypeScript, so src/wowexport/lib is copied as is.
import { cpSync, rmSync } from "node:fs";

rmSync("dist/wowexport/lib", { recursive: true, force: true });
cpSync("src/wowexport/lib", "dist/wowexport/lib", { recursive: true });
