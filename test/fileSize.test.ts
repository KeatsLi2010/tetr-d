import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const MAX_TYPESCRIPT_LINES = 400;
const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolute));
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function lineCount(file: string): number {
  const source = readFileSync(file, "utf8");
  if (source.length === 0) return 0;
  return source.split(/\r?\n/).length - (source.endsWith("\n") ? 1 : 0);
}

test("TypeScript and TSX files stay below the 400-line review boundary", () => {
  const offenders = ["apps", "packages"]
    .flatMap((root) => collectSourceFiles(path.join(PROJECT_ROOT, root)))
    .map((file) => ({
      file: path.relative(PROJECT_ROOT, file),
      lines: lineCount(file)
    }))
    .filter(({ lines }) => lines > MAX_TYPESCRIPT_LINES)
    .sort((left, right) => right.lines - left.lines);

  assert.deepEqual(offenders, []);
});
