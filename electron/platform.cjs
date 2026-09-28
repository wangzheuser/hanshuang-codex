"use strict";
/*
  平台判定与执行器调度 —— 全应用只有这一处决定「某个目标在当前系统上该怎么跑」。

  背景：功能原本 100% 由 install*.ps1（PowerShell）实现，非 Windows 上 spawn 直接
  ENOENT，界面上只报「退出码 -1」。现在按目标逐个补 Node 等价实现，就在这里登记，
  主进程不再到处写 if (!win32)。
*/

const os = require("node:os");
const wbInject = require("./workbuddy-inject.cjs");
const zcInject = require("./zcode-inject.cjs");
const cxInject = require("./codex-inject.cjs");

const platform = process.platform; // win32 | darwin | linux
const isWindows = platform === "win32";

/**
   每个目标在各平台的执行器：
     powershell —— 调 install*.ps1（Windows 主路径，经过大量实机验证）
     node       —— 调本目录下的等价 Node 实现
     null       —— 该平台尚未适配（界面给出可读原因，而不是 ENOENT）
*/
const EXECUTORS = {
  codex: { win32: "powershell", posix: "node" },
  zcode: { win32: "powershell", posix: "node" },
  cursor: { win32: "powershell", posix: null },
  claude: { win32: "powershell", posix: null },
  workbuddy: { win32: "powershell", posix: "node" },
  "workbuddy-cn": { win32: "powershell", posix: "node" },
  dsh: { win32: "powershell", posix: null },
  doubao: { win32: "powershell", posix: null },
};

const NODE_MODULES = {
  codex: cxInject,
  zcode: zcInject,
  workbuddy: wbInject,
  "workbuddy-cn": wbInject,
};

const NAV_LABEL = {
  codex: "Codex 破甲",
  zcode: "ZCode 破甲",
  cursor: "Cursor 破甲",
  claude: "Claude 破甲",
  workbuddy: "WorkBuddy 破甲（国际版）",
  "workbuddy-cn": "WorkBuddy 破甲（国内版）",
  dsh: "DeepSeek Harness 破甲",
  doubao: "豆包破甲",
};

const PLATFORM_NAME = { win32: "Windows", darwin: "macOS", linux: "Linux" };

function slot() {
  return isWindows ? "win32" : "posix";
}

/** "powershell" | "node" | "unsupported" */
function executorFor(targetId) {
  const entry = EXECUTORS[targetId];
  if (!entry) return "powershell";
  return entry[slot()] || "unsupported";
}

function nodeInjector(targetId) {
  return NODE_MODULES[targetId] || null;
}

/** 未适配时给用户的解释 —— 说清「为什么」和「什么时候能用」，而不是一个错误码。 */
function unsupportedMessage(targetId) {
  const name = NAV_LABEL[targetId] || targetId;
  const here = PLATFORM_NAME[platform] || platform;
  return `${name} 目前只支持 Windows —— 该目标由 install*.ps1（PowerShell）实现，${here} 版还没移植。`;
}

/** 给渲染层的能力表：界面据此标注哪些目标在当前系统可用。 */
function capabilities() {
  const targets = {};
  for (const id of Object.keys(EXECUTORS)) {
    targets[id] = {
      executor: executorFor(id),
      reason: executorFor(id) === "unsupported" ? unsupportedMessage(id) : "",
    };
  }
  return { platform, platformName: PLATFORM_NAME[platform] || platform, isWindows, homeDir: os.homedir(), targets };
}

module.exports = { platform, isWindows, executorFor, nodeInjector, unsupportedMessage, capabilities };
