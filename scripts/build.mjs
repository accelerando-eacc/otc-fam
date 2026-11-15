// npm run build: makes dist/, the static site, from web/. The base copies the files as they are;
// an entry may build any other way, as long as "npm run build" leaves dist/index.html.
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
cpSync("web", "dist", { recursive: true });
console.log("built dist/ from web/");
