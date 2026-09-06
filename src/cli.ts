#!/usr/bin/env bun
import * as fs from "fs";
import * as path from "path";
import { ARC56Generator } from "./generator";
import type { ARC56Contract } from "./types/arc56";

const HELP = `
algoKIT lite: typed client generator

Usage:
  algokit-lite generate <arc56.json> [options]

Generates a typed ARC-56 client from an ARC-56 JSON file.

Options:
  -o, --output <path>       Output file path (default: <name>Client.ts in the
                            same directory as the input, or stdout if omitted)
      --import-path <path>  Module specifier used for the generated import
                            statement (default: "algokit-lite")
  -h, --help                Show this help message
  -v, --version             Print the version
`;

interface CliOptions {
  arc56Path: string;
  outputPath?: string;
  importPath?: string;
}

function printVersion(): void {
  const content = fs.readFileSync(
    path.join(__dirname, "..", "package.json"),
    "utf-8",
  );
  const pkg = JSON.parse(content) as { version?: string };
  console.log(pkg.version ?? "0.0.0");
}

function parseArgs(argv: string[]): CliOptions {
  const arc56Paths: string[] = [];
  const options: CliOptions = { arc56Path: "" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;

    if (arg === "-h" || arg === "--help") {
      console.log(HELP);
      process.exit(0);
    }

    if (arg === "-v" || arg === "--version") {
      printVersion();
      process.exit(0);
    }

    if (arg === "-o" || arg === "--output") {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`Missing value for option: ${arg}`);
        process.exit(1);
      }
      options.outputPath = value;
      continue;
    }

    if (arg === "--import-path") {
      const value = argv[++i];
      if (value === undefined) {
        console.error(`Missing value for option: ${arg}`);
        process.exit(1);
      }
      options.importPath = value;
      continue;
    }

    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      console.error("Run with --help for usage.");
      process.exit(1);
    }

    arc56Paths.push(arg);
  }

  if (arc56Paths.length === 0) {
    console.error("Missing required <arc56.json> argument.");
    console.error("Run with --help for usage.");
    process.exit(1);
  }

  const arc56Path = arc56Paths[0] as string;
  options.arc56Path = arc56Path;
  return options;
}

async function main(): Promise<void> {
  const { arc56Path, outputPath, importPath } = parseArgs(Bun.argv.slice(2));

  const fullPath = path.resolve(arc56Path);
  if (!fs.existsSync(fullPath)) {
    console.error(`ARC-56 file not found: ${fullPath}`);
    process.exit(1);
  }

  let arc56: ARC56Contract;
  try {
    arc56 = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as ARC56Contract;
  } catch (err) {
    const message = err instanceof Error ? err.message : JSON.stringify(err);
    console.error(`Failed to parse ARC-56 JSON: ${message}`);
    process.exit(1);
  }

  const generator = new ARC56Generator(arc56, {
    clientImportPath: importPath ?? "algokit-lite",
  });

  const code = await generator.generate();

  const resolvedOutput =
    outputPath ??
    path.join(path.dirname(fullPath), `${arc56.name}Client.ts`);

  if (outputPath === "-") {
    process.stdout.write(code + "\n");
    return;
  }

  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.promises.writeFile(resolvedOutput, code, "utf-8");
  console.log(`Generated ${resolvedOutput}`);
}

void main();
