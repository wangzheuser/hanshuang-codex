/** preload 暴露的 IPC 接口的类型包装。 */

export type InstalledMap = Record<string, string | boolean>;

export type InstallResult = {
  ok: boolean;
  code: number;
  out: string;
  timedOut: boolean;
  installed: InstalledMap;
  error?: string;
};

/** 重启 Codex：out 是 PowerShell 的原样输出，失败时 error 里带可读原因。 */
export type RestartResult = { ok: boolean; code?: number; out?: string; error?: string };

export type Skill = { name: string; desc: string; enabled: boolean };

/** 主进程 platform.cjs 给出的能力表：某个目标在当前系统上用哪种执行器。 */
export type PlatformCaps = {
  platform: string;
  platformName: string;
  isWindows: boolean;
  homeDir: string;
  targets: Record<string, { executor: "powershell" | "node" | "unsupported"; reason: string }>;
};

/** memory/ 下正在使用的提示词文件；null = 用户还没填内容。 */
export type MemoryPrompt = { path: string; name: string; chars: number } | null;

/** 随包 Seep 逆向工作台状态。 */
export type SeepState = {
  /** 随包工具链是否完整（resources/seep-kit/setup/install.ps1 存在）。 */
  kit: boolean;
  /** 是否已部署到 ~/.pi/agent（mcp.json 里有 seep 条目）。 */
  installed: boolean;
  /** 随包工作台版本号。 */
  version: string;
};

export type AppState = {
  installed: InstalledMap;
  version: string;
  platform?: PlatformCaps;
};

export type LogPayload = { label: string; text: string };
export type StatusPayload = { label: string; state: "running" | "idle" };
export type NotifyPayload = { level: "info" | "warn"; text: string };

export type HsApi = {
  state(): Promise<AppState>;
  memory(): Promise<MemoryPrompt>;
  install(targetId: string): Promise<InstallResult>;
  uninstall(targetId: string): Promise<InstallResult>;
  /** 装回原始记忆（仅 WorkBuddy）：还原安装前的记忆档案，保留技能库。 */
  restoreMemory(targetId: string): Promise<InstallResult>;
  restartCodex(): Promise<RestartResult>;
  seepState(): Promise<SeepState>;
  seepInstall(): Promise<InstallResult>;
  seepUninstall(): Promise<InstallResult>;
  seepVerify(): Promise<InstallResult>;
  listSkills(): Promise<Skill[]>;
  saveSkills(disabled: string[]): Promise<{ ok: boolean; error?: string }>;
  openQQ(url: string): Promise<{ ok: boolean }>;
  quit(): Promise<{ ok: boolean }>;
  win(action: "minimize" | "maximize" | "close"): Promise<{ ok: boolean }>;
  onLog(cb: (p: LogPayload) => void): () => void;
  onStatus(cb: (p: StatusPayload) => void): () => void;
  onNotify(cb: (p: NotifyPayload) => void): () => void;
};

declare global {
  interface Window {
    hs: HsApi;
  }
}

export const hs: HsApi = window.hs;
