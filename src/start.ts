import { migrate } from "./database/migrate";

async function start(): Promise<void> {
  await migrate();
  await import("./main");
}

start().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
