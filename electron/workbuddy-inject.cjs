"use strict";
/*
  WorkBuddy 破甲注入 · 跨平台 Node 实现

  与 install-workbuddy.ps1 的注入点、文件格式、备份约定逐条对齐：
    1) <ConfigDir>/memory/<uid>_memory.md   云记忆档案（memoryBlock + RAW_JSON）
    2) <ConfigDir>/MEMORY.md                用户级文件记忆
    3) <ConfigDir>/app/app-config.json      generateMemoryEnabled / localMemoryEnabled
    4) <ConfigDir>/skills/<name>/           技能库 + .hanshuang-skills.json 安装清单
    5) <ConfigDir>/.hanshuang-state.json    注入状态（WorkBuddyGuard 读它做补注入）

  Windows 仍走 PowerShell（那条路径经过大量实机验证，不动）；这里服务 macOS / Linux
  以及任何没装 PowerShell 的机器。
*/

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MEM_VERSION = 999999; // 高版本号：程序回写时 incoming < existing 会被判 stale_version 拒绝
const SKILL_MANIFEST = ".hanshuang-skills.json";
const SHIPPED_SKILL_LIBS = ["codex-skills", "codex-skills-v3", "codex-skills-v4", "codex-skills-v5"];
const BLOCK_RE = /## Memory Block\r?\n\r?\n([\s\S]*?)\r?\n\r?\n---/;
const DATA_DIR_NAMES = [".workbuddy-ai", ".workbuddy"];

// ---------- 小工具 ----------

function readUtf8(file) {
  return fs.readFileSync(file, "utf8");
}

function writeUtf8(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

function sha256(file) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return "";
  }
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, ".000Z");
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/*
  只读锁。Windows 上应用写档案走 tmp+rename，rename 覆盖只读文件会 EPERM，锁能挡住回写；
  POSIX 的 rename 只看目标目录的写权限、不看目标文件的只读位，所以这里 chmod 挡不住 ——
  真正的兜底是 main.cjs 的 WorkBuddyGuard 定期补注入。仍然照设，能拦掉一部分场景且无害。
*/
function setReadOnly(file, ro) {
  try {
    if (exists(file)) fs.chmodSync(file, ro ? 0o444 : 0o644);
  } catch {
    /* 加固项，失败不中断 */
  }
}

function skillNames(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && exists(path.join(dir, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------- 路径解析 ----------

/**
  ConfigDir：显式指定 > ~\.workbuddy-ai > ~\.workbuddy > 兜底 ~\.workbuddy。
  不复制 PowerShell 的注册表 / product.json 探测 —— 那是 Windows 专属机制，
  且 Windows 上根本不会走到这个模块。
*/
function resolveConfigDir(homeDir, explicit) {
  if (explicit) return explicit;
  for (const name of DATA_DIR_NAMES) {
    const p = path.join(homeDir, name);
    if (exists(p)) return p;
  }
  return path.join(homeDir, ".workbuddy");
}

/** 本账户没有 WorkBuddy 数据时，扫其它账户目录（多用户机器 / 以别的名义运行）。 */
function findOtherConfigDirs(homeDir, primary) {
  const found = [];
  const roots = [path.dirname(homeDir), "/home", "/Users"];
  const seen = new Set();
  for (const usersRoot of roots) {
    if (seen.has(usersRoot)) continue;
    seen.add(usersRoot);
    let entries;
    try {
      entries = fs.readdirSync(usersRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const u of entries) {
      if (!u.isDirectory()) continue;
      for (const n of DATA_DIR_NAMES) {
        const cand = path.join(usersRoot, u.name, n);
        if (cand !== primary && exists(cand)) found.push(cand);
      }
    }
  }
  return found;
}

function resolveArchFiles(configDir, uid) {
  const memDir = path.join(configDir, "memory");
  if (uid) return { memDir, archFiles: [path.join(memDir, uid + "_memory.md")] };
  let entries = [];
  try {
    entries = fs.readdirSync(memDir, { withFileTypes: true });
  } catch {
    return { memDir, archFiles: [] };
  }
  const archFiles = entries
    .filter((d) => d.isFile() && d.name.endsWith("_memory.md") && !d.name.includes(".bak"))
    .map((d) => {
      const full = path.join(memDir, d.name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      return { full, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.full);
  return { memDir, archFiles };
}

function layout(ctx, configDir) {
  const { memDir, archFiles } = resolveArchFiles(configDir, ctx.uid);
  return {
    configDir,
    memDir,
    archFiles,
    fileMem: path.join(configDir, "MEMORY.md"),
    cfgFile: path.join(configDir, "app", "app-config.json"),
    skillsDir: path.join(configDir, "skills"),
    settingsFile: path.join(configDir, "settings.json"),
    manifestFile: path.join(configDir, "skills", SKILL_MANIFEST),
    stateFile: path.join(configDir, ".hanshuang-state.json"),
  };
}

/** 解析目标 + 跨账户兜底。显式指定数据目录时绝不兜底（国内/国际版会串）。 */
function resolveLayout(ctx) {
  let configDir = resolveConfigDir(ctx.homeDir, ctx.configDirExplicit);
  const pinned = !!ctx.configDirExplicit;
  if (!pinned && !exists(path.join(configDir, "memory"))) {
    const others = findOtherConfigDirs(ctx.homeDir, configDir).filter((d) =>
      exists(path.join(d, "memory"))
    );
    if (others.length) {
      ctx.log("  [跨账户] 本账户无 WorkBuddy 数据，改用: " + others[0]);
      configDir = others[0];
    }
  }
  return layout(ctx, configDir);
}

// ---------- app-config.json ----------

/** 不假设原文件结构：对象就合并，坏 JSON / 非对象留证据后重建。 */
function patchAppConfig(file, patch, log) {
  let cfg = null;
  if (exists(file)) {
    try {
      cfg = JSON.parse(readUtf8(file));
    } catch {
      cfg = null;
    }
  }
  const merged = {};
  if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
    Object.assign(merged, cfg);
  } else if (cfg !== null && cfg !== undefined) {
    try {
      fs.copyFileSync(file, file + ".broken-inject");
    } catch {
      /* ignore */
    }
    log("  [警告] app-config.json 结构异常，已另存 .broken-inject 并重建");
  }
  Object.assign(merged, patch);
  if (merged.locale === undefined) merged.locale = "zh-CN";
  writeUtf8(file, JSON.stringify(merged, null, 2) + "\n");
}

// ---------- skills ----------

function shippedSkillNames(toolDir) {
  const names = new Set();
  for (const lib of SHIPPED_SKILL_LIBS) {
    for (const n of skillNames(path.join(toolDir, lib))) names.add(n);
  }
  return [...names];
}

/** 清掉旧版遗留技能：候选 = 上次清单 ∪ 随包各技能库，且当前版本已没有、目录下确有 SKILL.md。 */
function pruneStaleSkills(ctx, skillsDir, previous, current) {
  const candidates = [...new Set([...previous, ...shippedSkillNames(ctx.toolDir)])].filter(Boolean);
  const removed = [];
  for (const name of candidates) {
    if (current.includes(name)) continue;
    const dest = path.join(skillsDir, name);
    if (!exists(dest) || !exists(path.join(dest, "SKILL.md"))) continue;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      ctx.log("  [提示] 清理旧技能失败 " + name + ": " + e.message);
    }
  }
  return removed;
}

/** settings.json 的 skillOverrides：删掉 key = 启用该技能。 */
function clearSkillOverrides(settingsFile, names, log) {
  if (!exists(settingsFile) || !names.length) return;
  let obj;
  try {
    obj = JSON.parse(readUtf8(settingsFile));
  } catch {
    return;
  }
  if (!obj || typeof obj !== "object" || !obj.skillOverrides || typeof obj.skillOverrides !== "object") return;
  let changed = false;
  for (const k of names) {
    if (Object.prototype.hasOwnProperty.call(obj.skillOverrides, k)) {
      delete obj.skillOverrides[k];
      changed = true;
    }
  }
  if (changed) {
    writeUtf8(settingsFile, JSON.stringify(obj, null, 2) + "\n");
    log("  已清除 skillOverrides 中 " + names.length + " 项禁用记录");
  }
}

// ---------- 档案读写 ----------

function archiveMarkdown(uid, block, now) {
  const raw = { uid, memoryBlock: block, updatedAt: now, version: MEM_VERSION };
  return (
    `# User Memory Profile\n> Last updated: ${now}\n> Version: ${MEM_VERSION}\n\n` +
    `## Memory Block\n\n${block}\n\n---\n\n` +
    `<!-- RAW_JSON_START\n${JSON.stringify(raw, null, 2)}\nRAW_JSON_END -->\n`
  );
}

function uidOfArchive(file) {
  try {
    const m = readUtf8(file).match(/"uid"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    /* ignore */
  }
  return path.basename(file).replace(/_memory\.md$/, "");
}

function memoryBlockOf(file) {
  try {
    const m = BLOCK_RE.exec(readUtf8(file));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

// ---------- 安装 ----------

function install(rawCtx) {
  const ctx = { ...rawCtx, out: "" };
  const log = (m) => {
    ctx.out += m + "\n";
    rawCtx.log(m);
  };

  if (!exists(ctx.sourcePrompt)) {
    return { ok: false, code: 1, out: "提示词文件不存在: " + ctx.sourcePrompt, timedOut: false };
  }
  const L = resolveLayout(ctx);
  const srcText = readUtf8(ctx.sourcePrompt);
  const srcHash = sha256(ctx.sourcePrompt);
  const now = nowIso();

  log("== WorkBuddy 破甲（Node 注入）==");
  log("  配置目录 : " + L.configDir);
  log("  版本判定 : " + variantOf(L.configDir));
  log("  提示词   : " + ctx.sourcePrompt);
  log("  档案     : " + (L.archFiles.length ? L.archFiles.length + " 个" : "未找到"));

  const failedArchives = [];

  // 1) 账号级云记忆档案
  if (L.archFiles.length) {
    fs.mkdirSync(L.memDir, { recursive: true });
    for (const af of L.archFiles) {
      const afBak = af + ".bak-inject";
      if (exists(af) && !exists(afBak)) {
        const oldBlock = memoryBlockOf(af);
        if (oldBlock !== srcText.trim()) {
          try {
            fs.copyFileSync(af, afBak);
          } catch (e) {
            log("  [提示] 备份档案失败(继续): " + e.message);
          }
        }
      }
      setReadOnly(af, false);
      let written = false;
      for (let attempt = 1; attempt <= 3 && !written; attempt++) {
        try {
          writeUtf8(af, archiveMarkdown(uidOfArchive(af), srcText, now));
          written = true;
        } catch (e) {
          log("  [提示] 档案写入失败(第 " + attempt + " 次): " + e.message);
        }
      }
      if (!written) {
        failedArchives.push(af);
        log("  [失败] 档案写入失败: " + path.basename(af));
        continue;
      }
      setReadOnly(af, true);
    }
    log(
      "[1] 云记忆档案已注入 memoryBlock：" +
        L.archFiles.length +
        " 个（" +
        srcText.trim().length +
        " 字符，Version " +
        MEM_VERSION +
        "）"
    );
    for (const af of L.archFiles) log("      - " + af);
  } else {
    log("[1] 云记忆档案未执行：该账号还没有记忆档案文件（WorkBuddy 未登录或从未产生记忆）");
    log("      处理：先在 WorkBuddy 里发一句话再重跑；或由守护自动补注入");
  }

  // 2) 用户级文件记忆
  const fileMemBak = L.fileMem + ".bak-inject";
  if (exists(L.fileMem) && !exists(fileMemBak) && sha256(L.fileMem) !== srcHash) {
    try {
      fs.copyFileSync(L.fileMem, fileMemBak);
    } catch {
      /* ignore */
    }
  }
  try {
    writeUtf8(L.fileMem, srcText);
    log("[2] MEMORY.md 已写入 " + fs.statSync(L.fileMem).size + " bytes");
  } catch (e) {
    log("  [提示] MEMORY.md 写入失败（可能被占用），已跳过: " + e.message);
  }

  // 3) 记忆总闸
  const cfgBak = L.cfgFile + ".bak-inject";
  if (exists(L.cfgFile) && !exists(cfgBak)) {
    try {
      fs.copyFileSync(L.cfgFile, cfgBak);
    } catch {
      /* ignore */
    }
  }
  patchAppConfig(L.cfgFile, { generateMemoryEnabled: true, localMemoryEnabled: true }, log);
  log("[3] generateMemoryEnabled = true（备份: " + cfgBak + "）");

  // 4) Skills
  const installedNames = [];
  if (ctx.noSkills) {
    log("[4] skills 未执行（noSkills）");
  } else if (!exists(ctx.skillsSourceDir)) {
    log("[4] skills 未执行（找不到 " + ctx.skillsSourceDir + "）");
  } else {
    fs.mkdirSync(L.skillsDir, { recursive: true });
    const prevSkills = readManifestNames(L.manifestFile);
    const manifest = {
      source: ctx.skillsSourceName,
      installedAt: now,
      prompt: path.basename(ctx.sourcePrompt),
      skills: {},
    };
    for (const name of skillNames(ctx.skillsSourceDir)) {
      const dest = path.join(L.skillsDir, name);
      try {
        fs.cpSync(path.join(ctx.skillsSourceDir, name), dest, { recursive: true, force: true });
        manifest.skills[name] = { sha256: sha256(path.join(dest, "SKILL.md")) };
        installedNames.push(name);
      } catch (e) {
        log("  [提示] 技能复制失败 " + name + ": " + e.message);
      }
    }
    installedNames.sort();
    writeUtf8(L.manifestFile, JSON.stringify(manifest, null, 2) + "\n");
    const stale = pruneStaleSkills(ctx, L.skillsDir, prevSkills, installedNames);
    if (stale.length) log("[4] 已清理旧版遗留 skills " + stale.length + " 个");
    clearSkillOverrides(L.settingsFile, installedNames, log);
    log("[4] skills 已装 " + installedNames.length + " 个 → " + L.skillsDir);
  }

  // 5) 注入状态（WorkBuddyGuard 据此补注入）
  const state = {
    prompt: path.basename(ctx.sourcePrompt),
    promptSha256: srcHash,
    configDir: L.configDir,
    uid: ctx.uid || "",
    memoryDir: L.memDir,
    archives: L.archFiles,
    archive: L.archFiles[0] || "",
    memoryFile: L.fileMem,
    appConfig: L.cfgFile,
    version: MEM_VERSION,
    skills: installedNames,
    installedAt: now,
    injectedBy: "node",
  };
  writeUtf8(L.stateFile, JSON.stringify(state, null, 2) + "\n");
  log("[5] 注入状态已记录 → " + L.stateFile);

  // 校验
  log("");
  log("[校验]");
  let ok = true;
  for (const af of L.archFiles.filter(exists)) {
    const blockOk = memoryBlockOf(af) === srcText.trim();
    let rawOk = false;
    try {
      rawOk = /"memoryBlock"/.test(readUtf8(af));
    } catch {
      /* ignore */
    }
    log("  档案 memoryBlock 可解析 : " + blockOk + "  (" + path.basename(af) + ")");
    if (!(blockOk && rawOk)) ok = false;
  }
  let cfg = null;
  try {
    cfg = JSON.parse(readUtf8(L.cfgFile));
  } catch {
    /* ignore */
  }
  log("  generateMemoryEnabled   : " + (cfg ? cfg.generateMemoryEnabled : "-"));
  if (!cfg || cfg.generateMemoryEnabled !== true) ok = false;
  log("  MEMORY.md 哈希一致      : " + (sha256(L.fileMem) === srcHash));
  if (sha256(L.fileMem) !== srcHash) ok = false;
  if (installedNames.length) log("  skills 落盘             : " + skillNames(L.skillsDir).length + " 个");

  if (failedArchives.length) {
    log("");
    log("[部分完成] 云记忆档案写入失败 " + failedArchives.length + " 个");
    return { ok: false, code: 2, out: ctx.out, timedOut: false };
  }
  log("");
  if (ok) {
    log("[完成] WorkBuddy 破甲注入成功 · 完全退出 WorkBuddy 后重启生效");
    return { ok: true, code: 0, out: ctx.out, timedOut: false };
  }
  log("[中断] 校验未通过，检查上面的失败项");
  return { ok: false, code: 1, out: ctx.out, timedOut: false };
}

function readManifestNames(manifestFile) {
  try {
    const m = JSON.parse(readUtf8(manifestFile));
    return m && m.skills ? Object.keys(m.skills) : [];
  } catch {
    return [];
  }
}

function variantOf(configDir) {
  const leaf = path.basename(configDir);
  if (leaf === ".workbuddy") return "国版";
  if (leaf === ".workbuddy-ai") return "国际版";
  return "自定义/品牌版";
}

// ---------- 卸载 ----------

function uninstall(rawCtx) {
  const ctx = { ...rawCtx, out: "" };
  const log = (m) => {
    ctx.out += m + "\n";
    rawCtx.log(m);
  };
  const L = resolveLayout(ctx);
  const done = [];

  log("== WorkBuddy 破甲 · 卸载（Node）==");
  log("  配置目录 : " + L.configDir);

  // 目标档案 = 本次扫描到的 + 状态文件记录过的（换账号后仍能清干净）
  const targets = [...L.archFiles];
  let st = null;
  try {
    st = JSON.parse(readUtf8(L.stateFile));
  } catch {
    st = null;
  }
  if (st) {
    for (const a of st.archives || []) if (a && !targets.includes(a)) targets.push(a);
    if (st.archive && !targets.includes(st.archive)) targets.push(st.archive);
  }

  for (const af of targets) {
    setReadOnly(af, false);
    const bak = af + ".bak-inject";
    if (exists(bak)) {
      fs.copyFileSync(bak, af);
      fs.rmSync(bak, { force: true });
      done.push("档案已从备份还原: " + path.basename(af));
    } else if (exists(af)) {
      writeUtf8(af, archiveMarkdown(path.basename(af).replace(/_memory\.md$/, ""), "", nowIso()));
      done.push("档案 memoryBlock 已清空: " + path.basename(af));
    }
  }
  if (!targets.length) done.push("云记忆档案未执行（该账号还没有档案文件）");

  if (exists(L.stateFile)) {
    fs.rmSync(L.stateFile, { force: true });
    done.push("注入状态文件已删除（守护停止重注入）");
  }

  const fileMemBak = L.fileMem + ".bak-inject";
  if (exists(fileMemBak)) {
    fs.copyFileSync(fileMemBak, L.fileMem);
    fs.rmSync(fileMemBak, { force: true });
    done.push("MEMORY.md 已从备份还原");
  } else if (exists(L.fileMem)) {
    fs.rmSync(L.fileMem, { force: true });
    done.push("MEMORY.md 已删除（无备份）");
  }

  const cfgBak = L.cfgFile + ".bak-inject";
  if (exists(cfgBak)) {
    fs.copyFileSync(cfgBak, L.cfgFile);
    fs.rmSync(cfgBak, { force: true });
    done.push("app-config.json 已从备份还原");
  } else if (exists(L.cfgFile)) {
    patchAppConfig(L.cfgFile, { generateMemoryEnabled: false, localMemoryEnabled: false }, log);
    done.push("app-config.json 无备份：两个记忆开关已置 false");
  }

  if (exists(L.manifestFile)) {
    let removed = 0;
    let kept = 0;
    const names = [];
    try {
      const m = JSON.parse(readUtf8(L.manifestFile));
      for (const [name, info] of Object.entries(m.skills || {})) {
        names.push(name);
        const dir = path.join(L.skillsDir, name);
        const skillMd = path.join(dir, "SKILL.md");
        if (exists(skillMd) && sha256(skillMd).toLowerCase() === String(info.sha256 || "").toLowerCase()) {
          fs.rmSync(dir, { recursive: true, force: true });
          removed++;
        } else if (exists(dir)) {
          kept++;
        }
      }
    } catch (e) {
      log("  [提示] 安装清单解析失败: " + e.message);
    }
    fs.rmSync(L.manifestFile, { force: true });
    clearSkillOverrides(L.settingsFile, names, log);
    done.push(`skills 已卸载 ${removed} 个（用户自行改过的保留 ${kept} 个）`);
  } else {
    done.push("skills 未执行（无安装清单）");
  }

  log("");
  log("[还原结果]");
  for (const d of done) log("  - " + d);
  return { ok: true, code: 0, out: ctx.out, timedOut: false };
}

module.exports = { install, uninstall, resolveLayout, archiveMarkdown, MEM_VERSION };
