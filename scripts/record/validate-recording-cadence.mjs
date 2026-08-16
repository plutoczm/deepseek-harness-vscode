#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_CONFIGURED_MOVE_MS = 600;
const DEFAULT_MAX_ACTUAL_MOVE_MS = 1000;

export function validateRecordingCadence(data, options = {}) {
  const maxConfiguredMoveMs =
    options.maxConfiguredMoveMs ?? DEFAULT_MAX_CONFIGURED_MOVE_MS;
  const maxActualMoveMs = options.maxActualMoveMs ?? DEFAULT_MAX_ACTUAL_MOVE_MS;
  const errors = [];
  const warnings = [];

  if (!data || data.schemaVersion !== 1 || !Array.isArray(data.actions)) {
    return {
      status: "failed",
      errors: ["动作数据必须是 runner 生成的 schemaVersion=1 JSON"],
      warnings,
      moveCount: 0,
    };
  }

  if (Number(data.stepDelayMs ?? 0) !== 0) {
    errors.push(
      `验收素材启用了 ${data.stepDelayMs}ms 的 RECORD_SLOWMO/slowMo；调试延迟不得进入素版或成品`
    );
  }

  const moves = data.actions.filter((item) => item.action === "moveTo");
  if (moves.length === 0) {
    warnings.push("动作数据中没有 moveTo，无法校验显式鼠标路径");
  }

  moves.forEach((move, index) => {
    const configured = Number(move.expectedDurationMs);
    const actual = Number(move.durationMs);
    const label = `moveTo #${index + 1}${move.detail ? ` (${move.detail})` : ""}`;

    if (!Number.isFinite(configured) || configured <= 0) {
      errors.push(`${label} 缺少有效 moveMs`);
    } else if (configured > maxConfiguredMoveMs) {
      errors.push(
        `${label} 配置 ${configured}ms，超过成片上限 ${maxConfiguredMoveMs}ms`
      );
    }

    if (!Number.isFinite(actual) || actual < 0) {
      errors.push(`${label} 缺少有效实际耗时`);
    } else if (actual > maxActualMoveMs) {
      errors.push(
        `${label} 实际 ${actual}ms，超过验收上限 ${maxActualMoveMs}ms`
      );
    }
  });

  return {
    status: errors.length === 0 ? "passed" : "failed",
    errors,
    warnings,
    moveCount: moves.length,
    limits: {
      maxConfiguredMoveMs,
      maxActualMoveMs,
    },
  };
}

function parseArgs(argv) {
  const args = [...argv];
  const input = args.shift();
  let jsonOutput = null;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--json-output") {
      jsonOutput = args.shift();
      if (!jsonOutput) throw new Error("--json-output 缺少路径");
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { input, jsonOutput };
}

function main() {
  const { input, jsonOutput } = parseArgs(process.argv.slice(2));
  if (!input) {
    console.error(
      "用法: node validate-recording-cadence.mjs <raw-actions.json> [--json-output <report.json>]"
    );
    process.exit(2);
  }

  const inputPath = resolve(input);
  if (!existsSync(inputPath)) {
    console.error(`动作数据不存在: ${inputPath}`);
    process.exit(2);
  }

  const report = validateRecordingCadence(
    JSON.parse(readFileSync(inputPath, "utf8"))
  );
  if (jsonOutput) {
    writeFileSync(resolve(jsonOutput), `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(
    `${report.status === "passed" ? "✅" : "❌"} 鼠标节奏: ${report.status} · moveTo=${report.moveCount}`
  );
  for (const warning of report.warnings) console.log(`⚠️  ${warning}`);
  for (const error of report.errors) console.error(`- ${error}`);
  process.exit(report.status === "passed" ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
