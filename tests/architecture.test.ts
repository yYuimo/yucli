import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import ts from "typescript";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const allowedDependencies: Record<string, readonly string[]> = {
  contracts: ["contracts"],
  core: ["core", "contracts"],
  adapters: ["adapters", "contracts"],
  bootstrap: ["bootstrap", "core", "adapters", "contracts"],
};

function listSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSources(path) : path.endsWith(".ts") ? [path] : [];
  });
}

it("源码 import 遵循四层依赖方向，contracts/core 不引入平台或外部包", () => {
  const violations: string[] = [];
  const files = listSources(sourceRoot);
  expect(files.length).toBeGreaterThan(0);

  for (const file of files) {
    const name = relative(sourceRoot, file).replaceAll("\\", "/");
    const layer = name.split("/")[0] ?? "";
    const allowed = allowedDependencies[layer];
    if (!allowed || !name.includes("/")) {
      violations.push(`${name}: 文件必须属于四层目录之一`);
      continue;
    }

    // TypeScript 解析 import/export、import type、动态 import 和 require，避免文本匹配漏掉依赖。
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
    for (const dependency of imports) {
      const specifier = dependency.fileName;
      if (!specifier.startsWith(".")) {
        if (layer === "contracts" || layer === "core") {
          violations.push(`${name}: 不允许外部依赖 ${specifier}`);
        }
        continue;
      }
      const target = ts.resolveModuleName(specifier, file, {
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      }, ts.sys).resolvedModule?.resolvedFileName;
      if (!target) {
        violations.push(`${name}: 无法解析 ${specifier}`);
        continue;
      }
      const targetLayer = relative(sourceRoot, target).replaceAll("\\", "/").split("/")[0] ?? "";
      if (!allowed.includes(targetLayer)) {
        violations.push(`${name}: ${layer} 不允许依赖 ${targetLayer} (${specifier})`);
      }
    }
  }
  expect(violations).toEqual([]);
});
