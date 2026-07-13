import { readdirSync } from "node:fs";
import { join } from "node:path";

export function migrationDirectory(): string {
  return join(__dirname, "migrations");
}

export function migrationFiles(): string[] {
  return readdirSync(migrationDirectory())
    .filter((file) => /^\d+.*\.sql$/.test(file))
    .sort();
}
