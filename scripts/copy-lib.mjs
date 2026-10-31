// Copies the ported CommonJS exporter code next to the compiled output.
// tsc only emits TypeScript, so src/wowexport/lib is copied as is.
import { cpSync, rmSync } from "node:fs";

rmSync("dist/wowexport/lib", { recursive: true, force: true });
cpSync("src/wowexport/lib", "dist/wowexport/lib", { recursive: true });
cpSync("src/wowexport/WOW_EXPORT_LICENSE", "dist/wowexport/WOW_EXPORT_LICENSE");
