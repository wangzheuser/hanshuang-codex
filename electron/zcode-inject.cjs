"use strict";
/*
  ZCode 破甲注入 · 跨平台 Node 实现（只做在 macOS / Linux 上确实生效的通道）

  生效通道：<ZcodeHome>/AGENTS.md —— ZCode 自己把它当作用户级默认指令文件读取
  （zcode.cjs 里 /init 的帮助文本原文：「the user default ~/.zcode/AGENTS.md」）。

  刻意不做的三件事（install-zcode.ps1 在 Windows 上做，Mac build 没有对应注入点，
  照做只会让界面报「成功」而实际什么都没发生）：
    · cli/memories/global/memory —— 3.12.3 的记忆按工作区分桶：
      memories/projects/<slug>-<sha256(workspacePath)[0:16]>/memory，没有 global 目录
    · ~/.zcode/skills —— 该 build 里没有任何读取全局技能目录的逻辑
    · patch zcode.cjs 的 u9o / s9o / Xlt —— Mac build 里这些混淆符号不存在，
      原脚本同样会 "skipped"；且该 app 带 hardened runtime 签名，改 .app 内文件会破坏签名
*/

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INJECTED_RE = /CTF-LAB|寒霜|Seagull/;

function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

function sha256File(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function stamp() {
  const d = new Date();
  const n = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
}

function resolveHome(ctx) {
  return ctx.zcodeHome || path.join(ctx.homeDir, ".zcode");
}

function install(ctx) {
  const log = ctx.log;
  const zcodeHome = resolveHome(ctx);

  log("== ZCode 破甲（Node 注入）==");
  log("  ZCode home : " + zcodeHome);
  log("  提示词     : " + ctx.sourcePrompt);

  if (!exists(zcodeHome)) {
    const msg =
      "未找到 ZCode 数据目录 " + zcodeHome + " —— ZCode 可能没装或从没启动过。先打开一次 ZCode 再重试。";
    log("[失败] " + msg);
    return { ok: false, code: 1, out: msg, timedOut: false, error: msg };
  }
  if (!exists(ctx.sourcePrompt)) {
    const msg = "提示词文件不存在: " + ctx.sourcePrompt;
    log("[失败] " + msg);
    return { ok: false, code: 1, out: msg, timedOut: false, error: msg };
  }

  const agentsPath = path.join(zcodeHome, "AGENTS.md");
  const statePath = path.join(zcodeHome, "install-state.json");

  let agentsBackup = null;
  if (exists(agentsPath)) {
    agentsBackup = path.join(zcodeHome, "AGENTS.md.backup-" + stamp());
    let n = 1;
    while (exists(agentsBackup)) agentsBackup = path.join(zcodeHome, `AGENTS.md.backup-${stamp()}-${++n}`);
    fs.copyFileSync(agentsPath, agentsBackup);
    log("[1/3] 已备份现有 AGENTS.md -> " + agentsBackup);
  }
  fs.copyFileSync(ctx.sourcePrompt, agentsPath);
  const srcHash = sha256File(ctx.sourcePrompt);
  const okWrite = sha256File(agentsPath) === srcHash;
  log("[2/3] 提示词已写入 -> " + agentsPath + (okWrite ? "（哈希一致）" : "（哈希不一致！）"));

  const state = {
    installedAt: new Date().toISOString(),
    zcodeHome,
    agentsPath,
    agentsBackup,
    promptSha256: srcHash,
    injectedBy: "node",
    skipped: {
      memory: "此 ZCode 版本按工作区分桶记忆（memories/projects/<slug>-<hash>/memory），无 global 注入点",
      skills: "此 ZCode 版本不读取 ~/.zcode/skills",
      systemPrompt: "Mac 版 zcode.cjs 无 u9o/s9o/Xlt 特征；且改 .app 内文件会破坏签名",
    },
  };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  log("[3/3] 安装状态已记录 -> " + statePath);

  log("");
  log("跳过的注入点（Mac 版无对应机制，不是失败）：");
  log("  - 全局记忆 / MEMORY.md 索引");
  log("  - ~/.zcode/skills 技能库");
  log("  - zcode.cjs 系统提示词 patch");
  log("");
  if (!okWrite) {
    return { ok: false, code: 1, out: "AGENTS.md 写入后哈希不一致", timedOut: false, error: "AGENTS.md 写入校验失败" };
  }
  log("[完成] AGENTS.md 已注入 · 重启 ZCode 生效");
  return { ok: true, code: 0, out: "", timedOut: false };
}

function uninstall(ctx) {
  const log = ctx.log;
  const zcodeHome = resolveHome(ctx);
  const agentsPath = path.join(zcodeHome, "AGENTS.md");
  const statePath = path.join(zcodeHome, "install-state.json");

  log("== ZCode 破甲 · 卸载（Node）==");
  log("  ZCode home : " + zcodeHome);

  if (!exists(zcodeHome)) {
    return { ok: false, code: 1, out: "未找到 " + zcodeHome, timedOut: false, error: "未找到 " + zcodeHome };
  }

  let state = null;
  try {
    state = JSON.parse(readUtf8(statePath));
  } catch {
    state = null;
  }

  // 优先 state 记录的备份；否则按「最老 → 最新」找第一份干净备份
  // （反复注入过的机器上，较新的备份本身也带着注入内容，越老的越接近原文件）
  const candidates = [];
  if (state && state.agentsBackup) candidates.push(state.agentsBackup);
  try {
    const backups = fs
      .readdirSync(zcodeHome, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.startsWith("AGENTS.md.backup-"))
      .map((d) => {
        const full = path.join(zcodeHome, d.name);
        let mtime = 0;
        try {
          mtime = fs.statSync(full).mtimeMs;
        } catch {
          /* ignore */
        }
        return { full, mtime };
      })
      .sort((a, b) => a.mtime - b.mtime)
      .map((x) => x.full);
    candidates.push(...backups);
  } catch {
    /* ignore */
  }

  let chosen = null;
  for (const cand of candidates) {
    if (!exists(cand)) continue;
    let clean = false;
    try {
      clean = !INJECTED_RE.test(readUtf8(cand));
    } catch {
      clean = false;
    }
    if (clean) {
      chosen = cand;
      break;
    }
  }

  if (chosen) {
    fs.copyFileSync(chosen, agentsPath);
    log("  - AGENTS.md 已从干净备份还原: " + chosen);
  } else if (exists(agentsPath)) {
    let cur = "";
    try {
      cur = readUtf8(agentsPath);
    } catch {
      cur = "";
    }
    if (INJECTED_RE.test(cur)) {
      fs.rmSync(agentsPath, { force: true });
      log("  - 没有干净备份，已删除注入的 AGENTS.md");
    } else {
      log("  - AGENTS.md 不是本工具写入的，保持原样");
    }
  } else {
    log("  - AGENTS.md 不存在，无需还原");
  }

  if (exists(statePath)) fs.rmSync(statePath, { force: true });
  log("  - install-state.json 已删除");
  return { ok: true, code: 0, out: "", timedOut: false };
}

module.exports = { install, uninstall };
