"use strict";
/*
  Codex 破甲注入 · 跨平台 Node 实现

  注入点与 install.ps1 逐条对齐（state 文件字段同名，Mac 上装的 Windows 脚本也能卸载）：
    1) <CodexHome>/managed-prompts/<提示词文件名>   提示词落盘，__CODEX_HOME__ 展开为实际路径
    2) <CodexHome>/config.toml                     model_instructions_file 指向 1
    3) <CodexHome>/AGENTS.md                       带「寒霜破甲注入开始/结束」标记的块
    4) <CodexHome>/skills/<name>/                  寒霜技能库
    5) <CodexHome>/managed-prompts/install-state.json

/*
  行为与 install.ps1 一致：装完会把非寒霜技能写进 [[skills.config]] enabled = false，
  卸载时按 state 里的 previousDisabledSkills 还原。
*/

const fs = require("node:fs");
const path = require("node:path");

const AGENTS_BEGIN = "<!-- 寒霜破甲注入开始";
const AGENTS_END = "<!-- 寒霜破甲注入结束 -->";
// 按「寒霜破甲…注入开始/结束」匹配而非写死整行，早先版本的「寒霜破甲 V5 注入开始」也要能认出
const BEGIN_RE = /<!--[^\r\n]*寒霜破甲[^\r\n]*注入开始[^\r\n]*-->/;
const END_RE = /<!--[^\r\n]*寒霜破甲[^\r\n]*注入结束[^\r\n]*-->/;
const MI_LINE = /^[ \t]*model_instructions_file[ \t]*=[ \t]*[^\r\n]*$/m;
const MI_LINE_WITH_NL = /^[ \t]*model_instructions_file[ \t]*=[ \t]*[^\r\n]*(?:\r?\n|$)/m;
const SHIPPED_SKILL_LIBS = ["codex-skills", "codex-skills-v3", "codex-skills-v4", "codex-skills-v5"];

function readUtf8(f) {
  return fs.readFileSync(f, "utf8");
}

function writeUtf8(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text, "utf8");
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// config.toml 里 Codex 认正斜杠路径；Windows 的反斜杠要转，POSIX 本来就是正斜杠
function fwd(p) {
  return p.replace(/\\/g, "/");
}

function norm(s) {
  return (s || "").replace(/\r\n/g, "\n").trim();
}

/** 定位 AGENTS.md 里的注入块，返回 {start, end} 绝对下标；没有则 null。 */
function findAgentsBlock(text) {
  if (!text) return null;
  const b = BEGIN_RE.exec(text);
  if (!b) return null;
  const start = b.index;
  const tailFrom = start + b[0].length;
  const e = END_RE.exec(text.slice(tailFrom));
  if (!e) return null;
  return { start, end: tailFrom + e.index + e[0].length };
}

/** 跟随符号链接判断是否目录 —— PowerShell 的 Get-ChildItem -Directory 会把指向目录的
 *  符号链接算进去，断链则跳过；不这么做的话用符号链接装的技能会漏出禁用范围。 */
function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function skillDirs(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => isDir(path.join(dir, n)) && exists(path.join(dir, n, "SKILL.md")))
      .sort();
  } catch {
    return [];
  }
}

// ---------- config.toml 的 [[skills.config]] ----------

/** 读出现在被禁用的技能名。只认 .../skills/<name>/SKILL.md 结构，畸形条目跳过。 */
function getDisabledSkills(configPath) {
  if (!exists(configPath)) return [];
  const out = [];
  for (const blk of splitSkillsBlocks(readUtf8(configPath)).blocks) {
    const mp = /^[ \t]*path[ \t]*=[ \t]*"([^"]+)"/m.exec(blk);
    if (!mp) continue;
    const me = /^[ \t]*enabled[ \t]*=[ \t]*(true|false)/m.exec(blk);
    const enabled = me ? me[1] === "true" : true;
    if (enabled) continue;
    const parts = mp[1].replace(/\\/g, "/").split("/").filter(Boolean);
    if (parts[parts.length - 1] !== "SKILL.md") continue;
    const name = parts[parts.length - 2];
    const parent = parts[parts.length - 3];
    if (name && name !== "skills" && parent && parent.toLowerCase() === "skills") out.push(name);
  }
  return [...new Set(out)];
}

/**
   重写 [[skills.config]] 段：只摘掉 path 指向本工具 skills 目录的块，
   用户自己写的（指向别处、比如自建技能库）原样保留 —— 早期实现把所有块一起删了
   再按清单重建，用户自己配的条目就永久丢了，而且他无从察觉。
*/
function setSkillsEnabledState(configPath, skillsTarget, disabledNames) {
  if (!exists(configPath)) return;
  const current = readUtf8(configPath);
  const { pre, blocks } = splitSkillsBlocks(current);
  const prefix = fwd(skillsTarget).replace(/\/+$/, "") + "/";
  const kept = blocks.filter((b) => {
    if (!b.startsWith("[[skills.config]]")) return true;
    const mp = /^[ \t]*path[ \t]*=[ \t]*"([^"]+)"/m.exec(b);
    return !(mp && fwd(mp[1]).toLowerCase().startsWith(prefix.toLowerCase()));
  });
  let text = (pre + kept.join("")).replace(/\s+$/, "") + "\n";
  for (const n of disabledNames) {
    if (!n || !n.trim() || n === "skills") continue;
    text +=
      "[[skills.config]]\n" +
      'path = "' +
      fwd(path.join(skillsTarget, n, "SKILL.md")) +
      '"\n' +
      "enabled = false\n";
  }
  writeUtf8(configPath, text);
}

/** 按标记行把文本切成「标记前的部分」+「每个 [[skills.config]] 块」。 */
function splitSkillsBlocks(text) {
  const re = /^[ \t]*\[\[skills\.config\]\][ \t]*$/gm;
  const starts = [];
  let m;
  while ((m = re.exec(text))) starts.push(m.index);
  if (!starts.length) return { pre: text, blocks: [] };
  return {
    pre: text.slice(0, starts[0]),
    blocks: starts.map((s, i) => text.slice(s, i + 1 < starts.length ? starts[i + 1] : text.length)),
  };
}

/** 禁用所有非寒霜技能（只装了提示词时不能走这里，否则会把用户自己的技能全禁用）。 */
function disableNonManagedSkills(configPath, skillsTarget, managedNames) {
  const toDisable = skillDirs(skillsTarget).filter((n) => !managedNames.includes(n));
  setSkillsEnabledState(configPath, skillsTarget, toDisable);
  return toDisable;
}

function shippedSkillNames(toolDir) {
  const set = new Set();
  for (const lib of SHIPPED_SKILL_LIBS) {
    for (const n of skillDirs(path.join(toolDir, lib))) set.add(n);
  }
  return [...set];
}

/**
   顶层区 = 第一个 [table] 头之前的部分。
   model_instructions_file 只有写在顶层才全局生效；按「文件里第一个匹配」读写，
   一旦顶层那行被 Codex 自己重写掉（它确实会重写 config.toml），就会误改到
   [profiles.xxx] 里的同名行 —— 实测踩过，表现为 profile 指向被换掉且顶层行丢失。
*/
function splitTopLevel(text) {
  const m = /^[ \t]*\[/m.exec(text);
  const cut = m ? m.index : text.length;
  return { top: text.slice(0, cut), rest: text.slice(cut) };
}

function paths(ctx) {
  const codexHome = ctx.codexHome;
  const managedDir = path.join(codexHome, "managed-prompts");
  return {
    codexHome,
    configPath: path.join(codexHome, "config.toml"),
    agentsPath: path.join(codexHome, "AGENTS.md"),
    managedDir,
    targetPrompt: path.join(managedDir, path.basename(ctx.sourcePrompt)),
    statePath: path.join(managedDir, "install-state.json"),
    skillsTarget: path.join(codexHome, "skills"),
  };
}

// ---------- 安装 ----------

function install(ctx) {
  const log = ctx.log;
  const P = paths(ctx);
  log("== Codex 破甲（Node 注入）==");
  log("  Codex home : " + P.codexHome);
  log("  提示词     : " + ctx.sourcePrompt);

  if (!exists(ctx.sourcePrompt)) {
    const msg = "提示词文件不存在: " + ctx.sourcePrompt;
    log("[失败] " + msg);
    return { ok: false, code: 1, out: msg, timedOut: false, error: msg };
  }

  fs.mkdirSync(P.codexHome, { recursive: true });
  fs.mkdirSync(P.managedDir, { recursive: true });

  const configExisted = exists(P.configPath);
  const configText = configExisted ? readUtf8(P.configPath) : "";
  const tl = splitTopLevel(configText);
  const found = MI_LINE.exec(tl.top);
  let previousLine = found ? found[0].replace(/\r$/, "") : null;

  /*
    「用户原本那一行是什么」必须在第一次安装时定下来，之后逐次继承，两种情况都要覆盖：
      · 当前行是上一次安装写的托管路径
      · 当前行根本不存在 —— Codex 会自己重写 config.toml 并丢掉 model_instructions_file，
        此时若按「没有就是用户原本没有」记录，卸载会直接删行，用户原本的指向永久丢失（实测踩过）
  */
  const carriedState = readJsonSafe(P.statePath);
  if (carriedState && Object.prototype.hasOwnProperty.call(carriedState, "previousLine")) {
    const carried = carriedState.previousLine ? String(carriedState.previousLine) : null;
    if (carried && !carried.includes("managed-prompts")) {
      if (previousLine !== carried) {
        previousLine = carried;
        log("  沿用原始配置行 : " + previousLine);
      }
    } else if (!carried && previousLine && previousLine.includes("managed-prompts")) {
      // 首次安装时用户确实没有这一行，后来那行是我们自己写的
      previousLine = null;
      log("  沿用原始状态 : 用户原本没有 model_instructions_file");
    }
  }

  // 1) 提示词落盘 + 展开 __CODEX_HOME__
  fs.copyFileSync(ctx.sourcePrompt, P.targetPrompt);
  const homeFwd = fwd(P.codexHome);
  let promptText = readUtf8(P.targetPrompt);
  if (promptText.includes("__CODEX_HOME__")) {
    promptText = promptText.split("__CODEX_HOME__").join(homeFwd);
    writeUtf8(P.targetPrompt, promptText);
    log("  路径展开   : __CODEX_HOME__ -> " + homeFwd);
  }

  // 2) config.toml 顶层的 model_instructions_file（profile 段里的同名行一律不碰）
  const newLine = 'model_instructions_file = "' + fwd(P.targetPrompt).replace(/"/g, '\\"') + '"';
  const newTop = MI_LINE.test(tl.top) ? tl.top.replace(MI_LINE, newLine) : newLine + "\n" + tl.top;
  writeUtf8(P.configPath, (newTop + tl.rest).replace(/\s+$/, "") + "\n");
  log("[1/4] 提示词已安装 -> " + P.targetPrompt);
  log("[2/4] config.toml 已更新 -> " + P.configPath);

  // 3) AGENTS.md 标记块
  let agentsResult = "";
  let agentsBackup = null;
  if (ctx.injectAgents) {
    const body = readUtf8(P.targetPrompt).replace(/\s+$/, "");
    const block = `${AGENTS_BEGIN} · ${path.basename(P.targetPrompt)} -->\n${body}\n${AGENTS_END}`;
    const normBody = norm(body);
    const existing = exists(P.agentsPath) ? readUtf8(P.agentsPath) : "";
    const normExisting = norm(existing);

    // 正文与要装的一模一样 = 这份 AGENTS.md 本来就是提示词本身（手工贴过 / 装过另一版），
    // 可以整份换成带标记的块
    let isPromptOnly = false;
    if (normExisting.length > 0) {
      if (normExisting === normBody) isPromptOnly = true;
      else {
        for (const k of ctx.agentsKnown || []) {
          if (!k || !exists(k)) continue;
          if (normExisting === norm(readUtf8(k))) {
            isPromptOnly = true;
            break;
          }
        }
      }
    }

    const blk = findAgentsBlock(existing);
    if (blk) {
      const merged = existing.slice(0, blk.start) + block + existing.slice(blk.end);
      writeUtf8(P.agentsPath, merged.replace(/\s+$/, "") + "\n");
      agentsResult = "updated";
    } else if (normExisting.length === 0 || isPromptOnly) {
      writeUtf8(P.agentsPath, block + "\n");
      agentsResult = isPromptOnly ? "replaced-manual" : "created";
    } else {
      // 用户自己的 AGENTS.md：先备份，再把块追加到末尾，原有内容一个字不动
      agentsBackup = path.join(P.codexHome, "AGENTS.md.backup-" + stamp());
      fs.copyFileSync(P.agentsPath, agentsBackup);
      writeUtf8(P.agentsPath, normExisting + "\n\n" + block + "\n");
      agentsResult = "appended (backup: " + path.basename(agentsBackup) + ")";
    }
    log("[3/4] AGENTS.md: " + agentsResult + " -> " + P.agentsPath);
  } else {
    log("[3/4] AGENTS.md 未注入（该版本不需要）");
  }

  // 4) skills
  let installedSkills = [];
  const prevState = readJsonSafe(P.statePath);
  const prevSkills = prevState && prevState.installedSkills ? prevState.installedSkills : [];
  /*
    「用户原本禁用了哪些技能」必须在第一次安装时就定下来，之后逐次继承。
    不能每次安装都重新读 config.toml —— 上一次安装写的 [[skills.config]] 已经在里面了，
    重读会把我们自己的禁用当成用户的，卸载时又原样还回去（表现为「卸载了但技能还是禁用」）。
  */
  const prevDisabled =
    prevState && Array.isArray(prevState.previousDisabledSkills)
      ? prevState.previousDisabledSkills
      : getDisabledSkills(P.configPath);
  let disabledNow = [];
  if (ctx.noSkills) {
    // 只装提示词时不能碰技能目录，否则会把用户自己的技能全禁用/删掉；
    // 上次装的清单原样带进 state，卸载时仍要能清干净
    installedSkills = prevSkills;
    log("[4/4] skills 未执行（noSkills），保留上次清单 " + installedSkills.length + " 条");
  } else if (!exists(ctx.skillsSourceDir)) {
    installedSkills = prevSkills;
    log("[4/4] skills 未执行（找不到 " + ctx.skillsSourceDir + "）");
  } else {
    fs.mkdirSync(P.skillsTarget, { recursive: true });
    for (const name of skillDirs(ctx.skillsSourceDir)) {
      fs.cpSync(path.join(ctx.skillsSourceDir, name), path.join(P.skillsTarget, name), {
        recursive: true,
        force: true,
      });
      installedSkills.push(name);
    }
    installedSkills.sort();
    const stale = [];
    const candidates = [...new Set([...prevSkills, ...shippedSkillNames(ctx.toolDir)])];
    for (const n of candidates) {
      if (installedSkills.includes(n)) continue;
      const dest = path.join(P.skillsTarget, n);
      if (!exists(dest) || !exists(path.join(dest, "SKILL.md"))) continue;
      fs.rmSync(dest, { recursive: true, force: true });
      stale.push(n);
    }
    log("[4/4] skills 已装 " + installedSkills.length + " 个 -> " + P.skillsTarget);
    if (stale.length) log("      已清理旧版遗留 " + stale.length + " 个");
    disabledNow = disableNonManagedSkills(P.configPath, P.skillsTarget, installedSkills);
    if (disabledNow.length) {
      log("      已禁用非寒霜技能 " + disabledNow.length + " 个：" + disabledNow.join(", "));
    }
  }

  // 提示词历史：换版本时清掉上一份，卸载时按这份清单删干净
  let promptHistory = [];
  if (prevState && prevState.promptHistory) promptHistory = [...prevState.promptHistory];
  else if (prevState && prevState.targetPrompt) promptHistory = [String(prevState.targetPrompt)];
  if (!promptHistory.includes(P.targetPrompt)) promptHistory.push(P.targetPrompt);
  for (const old of promptHistory) {
    if (old !== P.targetPrompt && exists(old)) {
      fs.rmSync(old, { force: true });
      log("      已移除上一版提示词: " + path.basename(old));
    }
  }

  const state = {
    installedAt: new Date().toISOString(),
    configPath: P.configPath,
    targetPrompt: P.targetPrompt,
    promptHistory,
    configExisted,
    hadLine: previousLine !== null,
    previousLine,
    installedSkills,
    installedBundles: prevState && prevState.installedBundles ? prevState.installedBundles : [],
    previousDisabledSkills: prevDisabled,
    agentsBackup,
    injectedBy: "node",
  };
  writeUtf8(P.statePath, JSON.stringify(state, null, 2) + "\n");

  // 校验
  log("");
  log("[校验]");
  let ok = true;
  const finalConfig = exists(P.configPath) ? readUtf8(P.configPath) : "";
  const lineOk = finalConfig.includes(newLine);
  log("  model_instructions_file 已指向托管提示词 : " + lineOk);
  if (!lineOk) ok = false;
  const promptOk = exists(P.targetPrompt) && readUtf8(P.targetPrompt) === promptText;
  log("  托管提示词与源一致                       : " + promptOk);
  if (!promptOk) ok = false;
  if (ctx.injectAgents) {
    const blk = findAgentsBlock(exists(P.agentsPath) ? readUtf8(P.agentsPath) : "");
    log("  AGENTS.md 注入块可定位                   : " + !!blk);
    if (!blk) ok = false;
  }
  if (installedSkills.length) {
    const onDisk = skillDirs(P.skillsTarget).length;
    log("  skills 落盘                              : " + installedSkills.length + " 个（目录内共 " + onDisk + " 个）");
  }
  log("");
  if (!ok) {
    return { ok: false, code: 1, out: "校验未通过", timedOut: false, error: "Codex 注入校验未通过（见日志）" };
  }
  log("[完成] Codex 破甲注入成功 · 重启 Codex 生效");
  return { ok: true, code: 0, out: "", timedOut: false };
}

function readJsonSafe(f) {
  try {
    return JSON.parse(readUtf8(f));
  } catch {
    return null;
  }
}

function stamp() {
  const d = new Date();
  const n = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
}

// ---------- 卸载 ----------

function uninstall(ctx) {
  const log = ctx.log;
  const P = paths(ctx);
  log("== Codex 破甲 · 卸载（Node）==");
  log("  Codex home : " + P.codexHome);

  const state = readJsonSafe(P.statePath);

  // 1) config.toml 顶层：还原安装前那一行；安装前没有这行就把整行删掉（profile 段不碰）
  if (exists(P.configPath)) {
    const { top, rest } = splitTopLevel(readUtf8(P.configPath));
    const isOwnPrev = !!(state && state.previousLine && String(state.previousLine).includes("managed-prompts"));
    let newTop = top;
    if (state && state.hadLine && state.previousLine && !isOwnPrev) {
      newTop = top.replace(MI_LINE_WITH_NL, String(state.previousLine) + "\n");
      log("  - config.toml 顶层已还原原 model_instructions_file 行");
    } else {
      newTop = top.replace(MI_LINE_WITH_NL, "");
      log("  - config.toml 顶层已移除 model_instructions_file 行");
    }
    writeUtf8(P.configPath, (newTop + rest).replace(/\s+$/, "") + "\n");
  }

  // 2) 托管提示词文件（按历史记录删，只删最后一次会残留前面的）
  const promptFiles = new Set();
  if (state) {
    for (const f of state.promptHistory || []) if (f) promptFiles.add(f);
    if (state.targetPrompt) promptFiles.add(String(state.targetPrompt));
  }
  if (!promptFiles.size) promptFiles.add(P.targetPrompt);
  for (const f of promptFiles) if (exists(f)) fs.rmSync(f, { force: true });
  log("  - 已删除托管提示词 " + promptFiles.size + " 份");

  // 3) AGENTS.md：只按标记摘除注入块，用户自己的内容原样保留
  if (exists(P.agentsPath)) {
    const text = readUtf8(P.agentsPath);
    const blk = findAgentsBlock(text);
    if (blk) {
      const left = (text.slice(0, blk.start) + text.slice(blk.end)).trim();
      if (!left) {
        fs.rmSync(P.agentsPath, { force: true });
        log("  - AGENTS.md 只装着注入块，已删除文件");
      } else {
        writeUtf8(P.agentsPath, left + "\n");
        log("  - 已从 AGENTS.md 摘除注入块，其余内容保留");
      }
    } else if (state && state.agentsBackup && exists(state.agentsBackup)) {
      fs.copyFileSync(state.agentsBackup, P.agentsPath);
      log("  - AGENTS.md 已从安装前备份还原");
    }
  }

  // 4) 只删寒霜装过的技能，其他一律不动
  if (state && state.installedSkills && state.installedSkills.length) {
    let removed = 0;
    for (const n of state.installedSkills) {
      const dest = path.join(P.skillsTarget, n);
      if (exists(dest)) {
        fs.rmSync(dest, { recursive: true, force: true });
        removed++;
      }
    }
    log("  - 已移除寒霜技能 " + removed + " 个（你自己的技能未动）");
  }

  // 5) 恢复安装前的技能启用状态：摘掉本工具写的 [[skills.config]]，只留用户原本禁用的那些
  const restoreDisabled = (state && state.previousDisabledSkills ? state.previousDisabledSkills : []).filter(
    (n) => typeof n === "string" && n.trim() && n !== "skills"
  );
  setSkillsEnabledState(P.configPath, P.skillsTarget, restoreDisabled);
  log(
    restoreDisabled.length
      ? "  - 已还原原先禁用的技能: " + restoreDisabled.join(", ")
      : "  - 包外技能已全部重新启用（清掉了寒霜写的禁用条目）"
  );

  // 6) Codex 记忆里的「寒霜注入」章节
  const memSummary = path.join(P.codexHome, "memories", "memory_summary.md");
  if (exists(memSummary)) {
    try {
      const t = readUtf8(memSummary);
      let next = t.replace(/^## [^\n]*寒霜注入[^\n]*\n[\s\S]*?(?=^## |\z)/gm, "");
      next = next.replace(/(\n){3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
      if (norm(next) !== norm(t)) {
        writeUtf8(memSummary, next);
        log("  - 已清除 Codex 记忆中的寒霜注入段");
      }
    } catch (e) {
      log("  [提示] 记忆清理跳过: " + e.message);
    }
  }

  if (exists(P.statePath)) fs.rmSync(P.statePath, { force: true });
  if (exists(P.managedDir)) {
    try {
      if (!fs.readdirSync(P.managedDir).length) fs.rmdirSync(P.managedDir);
    } catch {
      /* ignore */
    }
  }
  log("  - install-state.json 已删除");
  log("");
  log("[完成] Codex 已还原 · 重启 Codex 生效");
  return { ok: true, code: 0, out: "", timedOut: false };
}

module.exports = { install, uninstall, findAgentsBlock };
