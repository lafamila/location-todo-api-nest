module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: ".",
  testMatch: ["<rootDir>/test/**/*.spec.ts"],
  testPathIgnorePatterns: ["\\.e2e-spec\\.ts$"],
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.json" }] },
  testEnvironment: "node",
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/main.ts",
    "!src/database/migrate.ts",
  ],
};
