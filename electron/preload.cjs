"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// 渲染进程唯一的对外通道；不开 nodeIntegration。
contextBridge.exposeInMainWorld("hs", {
  state: () => ipcRenderer.invoke("tool:state"),
  memory: () => ipcRenderer.invoke("tool:memory"),
  install: (targetId) => ipcRenderer.invoke("tool:install", targetId),
  uninstall: (targetId) => ipcRenderer.invoke("tool:uninstall", targetId),
  // 装回原始记忆：还原安装前的记忆档案，保留技能库（仅 WorkBuddy）
  restoreMemory: (targetId) => ipcRenderer.invoke("tool:restoreMemory", targetId),
  restartCodex: () => ipcRenderer.invoke("tool:restartCodex"),
  // 随包分发的 Seep 逆向工作台
  seepState: () => ipcRenderer.invoke("seep:state"),
  seepInstall: () => ipcRenderer.invoke("seep:install"),
  seepUninstall: () => ipcRenderer.invoke("seep:uninstall"),
  seepVerify: () => ipcRenderer.invoke("seep:verify"),
  listSkills: () => ipcRenderer.invoke("tool:skills:list"),
  saveSkills: (disabled) => ipcRenderer.invoke("tool:skills:save", disabled),
  openQQ: (url) => ipcRenderer.invoke("tool:openQQ", url),
  quit: () => ipcRenderer.invoke("tool:quit"),
  win: (action) => ipcRenderer.invoke("tool:win", action),

  onLog: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("tool:log", h);
    return () => ipcRenderer.removeListener("tool:log", h);
  },
  onStatus: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("tool:status", h);
    return () => ipcRenderer.removeListener("tool:status", h);
  },
  onNotify: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("tool:notify", h);
    return () => ipcRenderer.removeListener("tool:notify", h);
  },
});
