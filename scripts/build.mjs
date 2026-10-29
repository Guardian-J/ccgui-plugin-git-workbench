#!/usr/bin/env node
/**
 * 将 src/*.js 按文件名顺序拼装为插件入口 main.js。
 * 插件宿主只加载单文件 ESM，因此分片内不得出现 import/require/eval/new Function。
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");
const outFile = join(root, "main.js");

const files = readdirSync(srcDir)
  .filter((name) => name.endsWith(".js"))
  .sort((a, b) => a.localeCompare(b, "en"));

if (!files.length) {
  console.error("src/ 下没有分片");
  process.exit(1);
}

const parts = [
  "/* 由 scripts/build.mjs 生成，请勿直接编辑。源文件：src/*.js */",
  "\"use strict\";",
];
for (const name of files) {
  const path = join(srcDir, name);
  if (!statSync(path).isFile()) continue;
  const code = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const badImport = code.match(/^\s*import\s/m);
  if (badImport) {
    console.error(`${name}: 不允许 import 语句（${badImport[0].trim()}）`);
    process.exit(1);
  }
  if (/(^|[^.\w])require\s*\(/.test(code)) {
    console.error(`${name}: 不允许 require()`);
    process.exit(1);
  }
  if (/(^|[^.\w])eval\s*\(/.test(code)) {
    console.error(`${name}: 不允许 eval()`);
    process.exit(1);
  }
  if (/new\s+Function\s*\(/.test(code)) {
    console.error(`${name}: 不允许 new Function()`);
    process.exit(1);
  }
  parts.push(`\n/* ===== ${name} ===== */\n`);
  parts.push(code.replace(/\s+$/, ""));
}

const output = parts.join("\n") + "\n";
writeFileSync(outFile, output, "utf8");

const check = spawnSync(process.execPath, ["--input-type=module", "--check"], {
  input: output,
  encoding: "utf8",
});
if (check.status !== 0) {
  console.error(check.stderr || check.stdout || "语法检查失败");
  process.exit(check.status || 1);
}

console.log(`main.js 生成完成：${files.length} 个分片，${(output.length / 1024).toFixed(1)} KiB`);
