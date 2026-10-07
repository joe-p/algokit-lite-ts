import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const fixture = fileURLToPath(
  new URL("./fixtures/ARC56Test.arc56.json", import.meta.url),
);

describe("CLI", () => {
  it("generates a client using the usage printed by --help", () => {
    const directory = mkdtempSync(join(tmpdir(), "algokit-lite-cli-"));
    const runCli = (args: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
        encoding: "utf-8",
      });

    try {
      const help = runCli(["--help"]);
      expect(help.status).toBe(0);
      const usage = help.stdout
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("algokit-lite "));
      expect(usage).toBe("algokit-lite <arc56.json> [options]");

      const output = join(directory, "ARC56TestClient.ts");
      const args = (usage ?? "")
        .split(" ")
        .slice(1)
        .flatMap((arg) => {
          if (arg === "<arc56.json>") return [fixture];
          if (arg === "[options]") return ["-o", output];
          return [arg];
        });
      const result = runCli(args);

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`Generated ${output}`);
      expect(readFileSync(output, "utf-8")).toContain(
        "export class ARC56TestClient extends ARC56AppClient",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
