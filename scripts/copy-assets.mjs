import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist/public", { recursive: true, force: true });
await rm("dist/database/migrations", { recursive: true, force: true });
await mkdir("dist/public", { recursive: true });
await mkdir("dist/database/migrations", { recursive: true });
await cp("web/dist", "dist/public", { recursive: true });
await cp("src/database/migrations", "dist/database/migrations", {
  recursive: true,
});
