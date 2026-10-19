"use strict";
/*
  DeepSeek Harness 破甲注入 · 跨平台 Node 实现

  注入点与 install-dsh.ps1 对齐（state 字段同名，Windows 脚本也能接着卸载）：
    1) <DshHome>/AGENTS.md                         整文件覆盖为提示词，首尾带 HANSHUANG-INJECT 标记
    2) <DshHome>/managed-prompts/AGENTS.md.bak     首次注入前的原文，卸载时还原
    3) <DshHome>/skills/<name>/                    随包技能库（本构建是 seep-kit/Tool/skill）
    4) <DshHome>/skills-disabled/                  competition-* 与 eni-redteam-*-detail-pack 停用
    5) <DshHome>/managed-prompts/install-state.json

  懒人包（dsh-lazy-pack-v5）若放在工具目录旁，行为与 -KitRoot 自动探测一致：
  提示词改取包内 materials/AGENTS.md，并部署 shield-protocol.md / prompt-inject。
  本构建默认不带懒人包，只走单文件提示词 + Seep 技能库。
*/

const fs = require("node:fs");
const path = require("node:path");

const MARKER = "<!-- HANSHUANG-INJECT:BEGIN -->";
const MARKER_PREFIX = "<!-- HANSHUANG-INJECT:BEGIN";
const MARKER_END = "<!-- HANSHUANG-INJECT:END -->";
const KIT_NAME = "dsh-lazy-pack-v5";
const SHIPPED_SKILL_LIBS = ["codex-skills", "codex-skills-v3", "codex-skills-v4", "codex-skills-v5"];

function readUtf8(file) {
  let text = fs.readFileSync(file, "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function writeUtf8(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

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
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && exists(path.join(dir, d.name, "SKILL.md")))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function frontmatterOk(skillMd) {
  let raw = "";
  try {
    raw = readUtf8(skillMd);
  } catch {
    return false;
  }
  if (!raw.startsWith("---")) return false;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return false;
  const fm = raw.slice(3, end);
  return /(^|\n)name:\s*\S/.test(fm) && /(^|\n)description:\s*\S/.test(fm);
}

function skillCurrent(srcDir, destDir) {
  const srcFile = path.join(srcDir, "SKILL.md");
  const dstFile = path.join(destDir, "SKILL.md");
  if (!exists(srcFile) || !exists(dstFile)) return false;
  try {
    const s = fs.statSync(srcFile);
    const d = fs.statSync(dstFile);
    if (s.size !== d.size) return false;
    return Math.abs(s.mtimeMs - d.mtimeMs) <= 2000;
  } catch {
    return false;
  }
}

function stamp() {
  const d = new Date();
  const n = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${n(d.getMonth() + 1)}${n(d.getDate())}-${n(d.getHours())}${n(d.getMinutes())}${n(d.getSeconds())}`;
}

function resolveDshHome(ctx) {
  return ctx.dshHome || path.join(ctx.homeDir, ".dsh");
}

function layout(ctx) {
  const dshHome = resolveDshHome(ctx);
  const managedDir = path.join(dshHome, "managed-prompts");
  return {
    dshHome,
    managedDir,
    agentsMd: path.join(dshHome, "AGENTS.md"),
    backupPath: path.join(managedDir, "AGENTS.md.bak"),
    statePath: path.join(managedDir, "install-state.json"),
    skillsTarget: path.join(dshHome, "skills"),
    disabledDir: path.join(dshHome, "skills-disabled"),
    shieldDst: path.join(dshHome, "shield-protocol.md"),
    shieldBak: path.join(managedDir, "shield-protocol.md.bak"),
    injectDst: path.join(dshHome, "prompt-inject.md"),
    injectCfg: path.join(dshHome, "dsh-prompt-inject.json"),
    injectBak: path.join(managedDir, "prompt-inject.md.bak"),
    cfgBak: path.join(managedDir, "dsh-prompt-inject.json.bak"),
  };
}

/** 与 install-dsh.ps1 的 Test-KitAt 相同：包根下必须有 materials/AGENTS.md。 */
function testKitAt(dir) {
  return Boolean(dir) && exists(path.join(dir, "materials", "AGENTS.md"));
}

function findKitRoot(toolDir) {
  if (process.env.HS_DSH_KIT && testKitAt(process.env.HS_DSH_KIT)) return process.env.HS_DSH_KIT;
  const parent = path.dirname(toolDir);
  for (const cand of [path.join(toolDir, KIT_NAME), path.join(parent, KIT_NAME), path.join(path.dirname(parent), KIT_NAME)]) {
    if (testKitAt(cand)) return cand;
  }
  return "";
}

function readState(statePath) {
  try {
    const obj = JSON.parse(readUtf8(statePath));
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

function asNames(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return [];
}

function asBackupMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string" && v) out[k] = v;
  }
  return out;
}

function isHeavySkill(name) {
  return name.startsWith("competition-") || (name.startsWith("eni-redteam-") && name.endsWith("-detail-pack"));
}

function copySkill(src, dest) {
  fs.cpSync(src, dest, { recursive: true, force: true, preserveTimestamps: true });
}

/** 懒人包标记是「BEGIN pack=…」，不能和单文件版的整行标记做全等比较。 */
function isInjected(text) {
  return Boolean(text && text.includes(MARKER_PREFIX));
}

function stripBomAndDropUnloadable(skillsTarget, ours, log) {
  let names;
  try {
    names = fs.readdirSync(skillsTarget, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  for (const name of names) {
    if (!ours.has(name)) continue;
    const skillMd = path.join(skillsTarget, name, "SKILL.md");
    if (!exists(skillMd)) continue;
    try {
      const buf = fs.readFileSync(skillMd);
      if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
        fs.writeFileSync(skillMd, buf.subarray(3));
        log("Stripped BOM: " + name);
      }
    } catch {
      /* 读不了就跳过，不误删 */
    }
    let text = "";
    try {
      text = readUtf8(skillMd);
    } catch {
      continue;
    }
    if (!text.startsWith("---")) {
      try {
        fs.rmSync(path.join(skillsTarget, name), { recursive: true, force: true });
        log("Removed non-loadable skill dir: " + name);
      } catch {
        /* ignore */
      }
    }
  }
}

function promoteNested(nested, skillsTarget, installed, log) {
  if (!isDir(nested)) return;
  let names = [];
  try {
    names = fs.readdirSync(nested, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return;
  }
  for (const name of names) {
    const src = path.join(nested, name);
    const skillMd = path.join(src, "SKILL.md");
    if (!frontmatterOk(skillMd)) continue;
    const dest = path.join(skillsTarget, name);
    if (exists(dest)) continue;
    copySkill(src, dest);
    installed.push(name);
    log("Promoted nested skill: " + name);
  }
  try {
    fs.rmSync(path.join(skillsTarget, "skills"), { recursive: true, force: true });
  } catch {
    /* 夹层没被复制进来时本来就不存在 */
  }
  for (const name of names) {
    const dest = path.join(skillsTarget, name);
    const skillMd = path.join(dest, "SKILL.md");
    if (!exists(skillMd)) continue;
    let raw = "";
    try {
      raw = readUtf8(skillMd);
    } catch {
      continue;
    }
    if (raw.startsWith("---")) continue;
    try {
      fs.rmSync(dest, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function moveHeavySkills(dshHome, skillsTarget, log) {
  const disabledDir = path.join(dshHome, "skills-disabled");
  const moved = [];
  for (const name of skillDirs(skillsTarget)) {
    if (!isHeavySkill(name)) continue;
    fs.mkdirSync(disabledDir, { recursive: true });
    const dst = path.join(disabledDir, name);
    try {
      if (exists(dst)) fs.rmSync(dst, { recursive: true, force: true });
      fs.renameSync(path.join(skillsTarget, name), dst);
      moved.push(name);
    } catch (e) {
      log("  [提示] 停用重技能失败 " + name + ": " + e.message);
    }
  }
  if (moved.length) log("Context-trimmed skills moved to skills-disabled: " + moved.length + " items");
  return moved;
}

/**
  安装技能。用户自己的同名目录先整份挪成 <名>.bak-<时间戳>，卸载时再搬回来。
  返回 { installed, backedUp }。
*/
function installSkills(ctx, L, skillsSource, prevNames, prevBackups, log) {
  const installed = [];
  const backedUp = { ...prevBackups };
  const dirs = skillDirs(skillsSource);
  if (!dirs.length) return { installed, backedUp };
  fs.mkdirSync(L.skillsTarget, { recursive: true });

  for (const name of dirs) {
    const src = path.join(skillsSource, name);
    const dest = path.join(L.skillsTarget, name);
    let justBackedUp = "";
    try {
      if (exists(dest) && !prevNames.includes(name)) {
        const bak = path.join(L.skillsTarget, name + ".bak-" + stamp());
        fs.renameSync(dest, bak);
        backedUp[name] = bak;
        justBackedUp = bak;
        log("Backed up existing skill " + name + " -> " + path.basename(bak));
      }
      if (skillCurrent(src, dest)) {
        installed.push(name);
        continue;
      }
      if (exists(dest)) fs.rmSync(dest, { recursive: true, force: true });
      copySkill(src, dest);
      installed.push(name);
    } catch (e) {
      if (justBackedUp && exists(justBackedUp) && !exists(dest)) {
        try {
          fs.renameSync(justBackedUp, dest);
          delete backedUp[name];
        } catch {
          /* 备份还在，卸载时再搬回来 */
        }
      }
      log("  [提示] 技能复制失败 " + name + ": " + e.message);
    }
  }

  promoteNested(path.join(skillsSource, "skills"), L.skillsTarget, installed, log);
  const ours = new Set([...prevNames, ...installed]);
  stripBomAndDropUnloadable(L.skillsTarget, ours, log);
  moveHeavySkills(L.dshHome, L.skillsTarget, log);
  // 没 frontmatter 被删掉的不入清单；停用进 skills-disabled 的仍要记账，卸载才认得出
  const stillThere = new Set([...skillDirs(L.skillsTarget), ...skillDirs(L.disabledDir)]);
  return { installed: installed.filter((n) => stillThere.has(n)), backedUp };
}

function shippedSkillNames(toolDir, skillsSource, kitRoot) {
  const names = new Set();
  const libs = [skillsSource, ...SHIPPED_SKILL_LIBS.map((lib) => path.join(toolDir, lib))];
  const parent = path.dirname(toolDir);
  for (const base of [toolDir, parent, path.dirname(parent)]) {
    libs.push(path.join(base, KIT_NAME, "materials", "skills"));
  }
  if (kitRoot) libs.push(path.join(kitRoot, "materials", "skills"));
  for (const lib of libs) {
    for (const n of skillDirs(lib)) names.add(n);
    const nested = path.join(lib, "skills");
    if (!isDir(nested)) continue;
    try {
      for (const name of fs.readdirSync(nested)) {
        const skillMd = path.join(nested, name, "SKILL.md");
        if (frontmatterOk(skillMd)) names.add(name);
      }
    } catch {
      /* ignore */
    }
  }
  return names;
}

function removeManagedSkills(L, names, shipped, log) {
  const removed = [];
  for (const name of names) {
    if (!name || !shipped.has(name)) continue;
    let hit = false;
    for (const dest of [path.join(L.skillsTarget, name), path.join(L.disabledDir, name)]) {
      if (!exists(dest)) continue;
      try {
        fs.rmSync(dest, { recursive: true, force: true });
        hit = true;
      } catch (e) {
        log("  [提示] 删除技能失败 " + name + ": " + e.message);
      }
    }
    if (hit) removed.push(name);
  }
  return removed;
}

function restoreUserSkills(L, backups, log) {
  for (const [name, bak] of Object.entries(backups || {})) {
    if (!bak || !exists(bak)) continue;
    const dest = path.join(L.skillsTarget, name);
    try {
      if (exists(dest)) fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(bak, dest);
      log("Restored original skill: " + name);
    } catch (e) {
      log("  [提示] 还原用户技能失败 " + name + ": " + e.message);
    }
  }
}

function setPromptInjectConfig(cfgPath, templateId, templateName, text, makeDefault) {
  let cfg = null;
  if (exists(cfgPath)) {
    try {
      cfg = JSON.parse(readUtf8(cfgPath));
    } catch {
      cfg = null;
    }
  }
  const templates = cfg && Array.isArray(cfg.templates) ? cfg.templates.slice() : [];
  const sessions = cfg && cfg.sessions && typeof cfg.sessions === "object" ? cfg.sessions : {};
  let def = cfg && typeof cfg.defaultTemplate === "string" ? cfg.defaultTemplate : "";
  let hit = false;
  for (const t of templates) {
    if (t && t.id === templateId) {
      t.text = text;
      t.name = templateName;
      hit = true;
    }
  }
  if (!hit) templates.push({ id: templateId, name: templateName, text, order: 1 });
  if (makeDefault && !def) def = templateId;
  writeUtf8(cfgPath, JSON.stringify({ templates, sessions, defaultTemplate: def }, null, 2) + "\n");
}

function installKitFiles(kitRoot, L, log) {
  const deployed = [];
  const shieldSrc = path.join(kitRoot, "materials", "shield-protocol.md");
  const injectSrc = path.join(kitRoot, "prompts", "operator-config-v5.md");
  const coffeeSrc = path.join(kitRoot, "prompts", "cold-coffee.md");
  if (!exists(shieldSrc) || !exists(injectSrc)) {
    log("  [提示] 懒人包缺少 shield / prompt-inject 源文件，跳过包文件部署");
    return deployed;
  }
  // 必须先备份再覆盖。反过来会把刚写入的注入内容存成「原文」，卸载时还原不掉。
  if (exists(L.shieldDst) && !exists(L.shieldBak)) fs.copyFileSync(L.shieldDst, L.shieldBak);
  fs.copyFileSync(shieldSrc, L.shieldDst);
  deployed.push("shield-protocol.md");
  if (exists(L.injectDst) && !exists(L.injectBak)) fs.copyFileSync(L.injectDst, L.injectBak);
  fs.copyFileSync(injectSrc, L.injectDst);
  deployed.push("prompt-inject.md");
  if (exists(L.injectCfg) && !exists(L.cfgBak)) fs.copyFileSync(L.injectCfg, L.cfgBak);
  setPromptInjectConfig(L.injectCfg, "pojia-default", "pojia", readUtf8(injectSrc), true);
  deployed.push("dsh-prompt-inject.json");
  if (exists(coffeeSrc)) {
    setPromptInjectConfig(L.injectCfg, "cold-coffee", "冷咖啡", readUtf8(coffeeSrc), false);
  }
  return deployed;
}

function stripKitTemplates(cfgPath, log) {
  try {
    const cfg = JSON.parse(readUtf8(cfgPath));
    const keep = (Array.isArray(cfg.templates) ? cfg.templates : []).filter(
      (t) => t && t.id !== "pojia-default" && t.id !== "cold-coffee",
    );
    let def = typeof cfg.defaultTemplate === "string" ? cfg.defaultTemplate : "";
    if (def === "pojia-default" || def === "cold-coffee") def = "";
    const sessions = cfg.sessions && typeof cfg.sessions === "object" ? cfg.sessions : {};
    writeUtf8(cfgPath, JSON.stringify({ templates: keep, sessions, defaultTemplate: def }, null, 2) + "\n");
    log("Removed kit templates from dsh-prompt-inject.json");
  } catch {
    log("Failed to clean dsh-prompt-inject.json, left as-is");
  }
}

function restoreOrRemove(dst, bak, label, log) {
  if (exists(bak)) {
    fs.copyFileSync(bak, dst);
    fs.rmSync(bak, { force: true });
    log("Restored original " + label);
  } else if (exists(dst)) {
    fs.rmSync(dst, { force: true });
    log("Removed " + label);
  }
}

function resolveSkillsSource(ctx) {
  if (ctx.skillsSourceDir && exists(ctx.skillsSourceDir)) return ctx.skillsSourceDir;
  const seep = path.join(ctx.toolDir, "seep-kit", "Tool", "skill");
  if (exists(seep)) return seep;
  return path.join(ctx.toolDir, "codex-skills");
}

function fail(msg) {
  return { ok: false, code: 1, out: msg, timedOut: false, error: msg };
}

function install(ctx) {
  const log = ctx.log;
  const L = layout(ctx);
  const kitRoot = findKitRoot(ctx.toolDir);
  const isKit = Boolean(kitRoot);
  const sourcePrompt = isKit ? path.join(kitRoot, "materials", "AGENTS.md") : ctx.sourcePrompt;
  const skillsSource = isKit ? path.join(kitRoot, "materials", "skills") : resolveSkillsSource(ctx);
  const markerBegin = isKit ? "<!-- HANSHUANG-INJECT:BEGIN pack=" + KIT_NAME + " -->" : MARKER;

  log("== DeepSeek Harness 破甲（Node 注入）==");
  log("  DSH home : " + L.dshHome);
  log("  模式     : " + (isKit ? "懒人包 " + kitRoot : "单文件提示词"));
  log("  提示词   : " + sourcePrompt);
  log("  技能库   : " + skillsSource);

  if (!sourcePrompt || !exists(sourcePrompt)) return fail("提示词文件不存在: " + (sourcePrompt || "(空)"));

  const prev = readState(L.statePath);
  const prevSkills = asNames(prev.installedSkills);
  const prevBackups = asBackupMap(prev.backedUpSkills);

  fs.mkdirSync(L.dshHome, { recursive: true });
  fs.mkdirSync(L.managedDir, { recursive: true });

  let curAgents = "";
  if (exists(L.agentsMd)) {
    try {
      curAgents = readUtf8(L.agentsMd);
    } catch {
      curAgents = "";
    }
    const injected = isInjected(curAgents);
    const curIsKit = curAgents.includes("pack=" + KIT_NAME);
    if (injected && curIsKit !== isKit) {
      if (!exists(L.backupPath)) {
        fs.copyFileSync(L.agentsMd, L.backupPath);
        log("Injection mode changed, recorded pre-injection backup");
      } else {
        log("Injection mode changed, keeping original pre-injection backup");
      }
    } else if (injected) {
      log("AGENTS.md already injected, updating content");
    } else if (!exists(L.backupPath)) {
      fs.copyFileSync(L.agentsMd, L.backupPath);
      log("Backed up original AGENTS.md");
    }
  } else {
    log("No existing AGENTS.md, creating new");
  }

  const promptText = readUtf8(sourcePrompt);
  const injected = markerBegin + "\n" + promptText.replace(/[\r\n]+$/, "") + "\n" + MARKER_END + "\n";
  writeUtf8(L.agentsMd, injected);
  log("Injected prompt -> " + L.agentsMd);

  const t0 = Date.now();
  const { installed, backedUp } = installSkills(ctx, L, skillsSource, prevSkills, prevBackups, log);
  log("[TIME] 技能安装: " + (Date.now() - t0) + " ms");
  if (installed.length) log("Installed skills: " + installed.join(", "));

  const shipped = shippedSkillNames(ctx.toolDir, skillsSource, kitRoot);
  const stale = removeManagedSkills(
    L,
    prevSkills.filter((n) => shipped.has(n) && !installed.includes(n)),
    shipped,
    log,
  );
  if (stale.length) log("Pruned stale skills from previous version: " + stale.join(", "));

  let kitFiles = [];
  if (isKit) {
    const t1 = Date.now();
    kitFiles = installKitFiles(kitRoot, L, log);
    log("[TIME] 包文件部署: " + (Date.now() - t1) + " ms");
    if (kitFiles.length) log("Deployed kit files: " + kitFiles.join(", "));
    log("提示：prompt-inject.md 与 dsh-prompt-inject.json 需装 dsh-prompt-inject 插件才注入系统提示词；AGENTS.md 与 shield-protocol.md 无需插件。");
  }

  const state = {
    installedSkills: installed,
    kit: isKit,
    kitFiles,
    prompt: path.basename(sourcePrompt),
    injectedBy: "node",
  };
  if (Object.keys(backedUp).length) state.backedUpSkills = backedUp;
  writeUtf8(L.statePath, JSON.stringify(state, null, 2) + "\n");
  log("DSH injection complete");

  let written = "";
  try {
    written = readUtf8(L.agentsMd);
  } catch {
    written = "";
  }
  if (!isInjected(written) || !written.includes(MARKER_END)) {
    return fail("AGENTS.md 写入后找不到注入标记");
  }
  log("[完成] AGENTS.md 已注入 · 重启 DeepSeek Harness 生效");
  return { ok: true, code: 0, out: "", timedOut: false };
}

/**
  restoreMemory=true：只还原 AGENTS.md 与懒人包文件，技能和 install-state.json 保留。
*/
function uninstall(ctx) {
  return teardown(ctx, false);
}

function restoreMemory(ctx) {
  return teardown(ctx, true);
}

function teardown(ctx, restoreOnly) {
  const log = ctx.log;
  const L = layout(ctx);
  const kitRoot = findKitRoot(ctx.toolDir);
  const skillsSource = resolveSkillsSource(ctx);

  log("== DeepSeek Harness 破甲 · " + (restoreOnly ? "装回原始记忆" : "卸载") + "（Node）==");
  log("  DSH home : " + L.dshHome);

  if (!exists(L.dshHome)) {
    log("  ~/.dsh 不存在，无需清理");
    return { ok: true, code: 0, out: "", timedOut: false };
  }

  const prev = readState(L.statePath);
  let prevSkills = asNames(prev.installedSkills);

  let curText = "";
  if (exists(L.agentsMd)) {
    try {
      curText = readUtf8(L.agentsMd);
    } catch {
      curText = "";
    }
  }
  const curIsKit = curText.includes("pack=" + KIT_NAME);
  const curInjected = isInjected(curText);

  if (!restoreOnly && prevSkills.length === 0) {
    const shippedNow = shippedSkillNames(ctx.toolDir, skillsSource, kitRoot);
    const leftover = [...shippedNow].filter((n) => exists(path.join(L.skillsTarget, n)));
    if (leftover.length) {
      prevSkills = leftover;
      log("Recovered skill inventory from disk: " + leftover.length + " items");
    }
  }

  if (exists(L.backupPath)) {
    fs.copyFileSync(L.backupPath, L.agentsMd);
    fs.rmSync(L.backupPath, { force: true });
    log("Restored original AGENTS.md");
  } else if (curInjected) {
    fs.rmSync(L.agentsMd, { force: true });
    log("Removed injected AGENTS.md");
  } else {
    log("No injection found, nothing to do");
  }

  if (curIsKit) {
    restoreOrRemove(L.shieldDst, L.shieldBak, "shield-protocol.md", log);
    restoreOrRemove(L.injectDst, L.injectBak, "prompt-inject.md", log);
    if (exists(L.injectCfg)) {
      if (exists(L.cfgBak)) {
        fs.copyFileSync(L.cfgBak, L.injectCfg);
        fs.rmSync(L.cfgBak, { force: true });
        log("Restored original dsh-prompt-inject.json");
      } else {
        stripKitTemplates(L.injectCfg, log);
      }
    }
  }

  if (restoreOnly) {
    log("Restore-memory: managed skills and install-state.json kept");
    return { ok: true, code: 0, out: "", timedOut: false };
  }

  const shipped = shippedSkillNames(ctx.toolDir, skillsSource, kitRoot);
  const removed = removeManagedSkills(L, prevSkills, shipped, log);
  log(removed.length ? "Removed managed skills: " + removed.join(", ") : "No managed skills to remove");
  restoreUserSkills(L, asBackupMap(prev.backedUpSkills), log);

  try {
    writeUtf8(L.statePath, JSON.stringify({ uninstalled: true, installedSkills: prevSkills }, null, 2) + "\n");
  } catch {
    log("Failed to write uninstall marker, next run will recover from disk");
  }
  log("[完成] DeepSeek Harness 注入内容已清理");
  return { ok: true, code: 0, out: "", timedOut: false };
}

module.exports = { install, uninstall, restoreMemory };
