import { useMemo, useState } from "react";

import type { Target } from "../data/targets";
import type { StatusLevel } from "../App";
import { cx } from "../lib/cx";
import { IconCheck } from "../components/icons";

type Props = {
  target: Target;
  installed?: string | boolean;
  busy: boolean;
  status: string;
  level: StatusLevel;
  logText: string;
  unsupportedReason?: string;
  onInstall: (file: string, label?: string) => void;
  onUninstall: () => void;
  onRestart: () => void;
};

export function InstallPage({
  target,
  installed,
  busy,
  status,
  level,
  logText,
  unsupportedReason = "",
  onInstall,
  onUninstall,
  onRestart,
}: Props) {
  const defaultIndex = useMemo(() => {
    const i = target.versions.findIndex((v) => v.recommended);
    return i >= 0 ? i : 0;
  }, [target]);

  const [index, setIndex] = useState(defaultIndex);
  const selected = target.versions[index];
  const isInstalled = Boolean(installed);

  // 一个版本对应多份提示词时（V5 的「六 / 5.6」），点安装先弹框选具体那一份
  const choices = selected?.choices ?? [];
  const [pickOpen, setPickOpen] = useState(false);
  const [pickIndex, setPickIndex] = useState(0);
  const picked = choices[pickIndex];

  const startInstall = () => {
    if (!selected) return;
    if (choices.length > 0) {
      setPickIndex(0);
      setPickOpen(true);
      return;
    }
    onInstall(selected.file, selected.name);
  };

  const confirmPick = () => {
    if (!picked) return;
    setPickOpen(false);
    onInstall(picked.file, selected ? selected.name + " · " + picked.name : picked.name);
  };

  return (
    <>
      <h1 className="settings-section-title">{target.title}</h1>

      <div className="settings-card-block">
        <div className="settings-card-heading-row">
          <div>
            <h2 className="settings-card-heading">
              {target.versions.length > 1 ? "选择版本" : "版本"}
            </h2>
            <p className="settings-card-description">{target.desc}</p>
          </div>
          <span className={cx("badge", isInstalled ? "badge-success" : "badge-neutral")}>
            {isInstalled
              ? "已安装" + (typeof installed === "string" ? " · " + installed : "")
              : "未安装"}
          </span>
        </div>

        {target.versions.length === 1 ? (
          /* 只有一个版本时不做成可选项，直接展示将要注入的版本 */
          <div className="settings-panel">
            <div className="settings-row">
              <span className="settings-row-copy">
                <div className="settings-row-title">{selected?.name}</div>
                <div className="settings-row-desc">{selected?.desc}</div>
              </span>
              <span className="settings-row-control">
                <span className="badge badge-neutral">PRO</span>
              </span>
            </div>
          </div>
        ) : (
        <div className="settings-panel">
          {target.versions.map((v, i) => (
            <button
              key={v.file + v.name}
              type="button"
              className={cx("settings-row", "app-row-button", i === index && "app-row-selected")}
              onClick={() => setIndex(i)}
            >
              <span className="settings-row-copy">
                <div className="settings-row-title">
                  {v.name}
                  {v.choices && v.choices.length > 0 && (
                    <span className="badge badge-neutral" style={{ marginLeft: 8 }}>
                      二选一
                    </span>
                  )}
                </div>
                <div className="settings-row-desc">{v.desc}</div>
              </span>
              <span className="settings-row-control">
                {v.recommended && <span className="badge badge-neutral">推荐</span>}
                {i === index && <IconCheck size={16} />}
              </span>
            </button>
          ))}
        </div>
        )}

        {unsupportedReason && (
          <div className="panel-card" style={{ padding: "10px 12px", marginBottom: 12 }}>
            <p className="settings-card-description" style={{ margin: 0 }}>
              {unsupportedReason}
            </p>
          </div>
        )}

        <div className="app-inline-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || Boolean(unsupportedReason)}
            onClick={startInstall}
          >
            {busy ? "执行中…" : isInstalled ? "重新安装" : "安装"}
          </button>
          {target.id === "codex" && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || Boolean(unsupportedReason)}
              onClick={onRestart}
            >
              重启 Codex
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || Boolean(unsupportedReason)}
            onClick={onUninstall}
          >
            {target.uninstallLabel}
          </button>
        </div>
      </div>

      <div className="settings-card-block">
        <div className="settings-card-heading-row">
          <div>
            <h2 className="settings-card-heading">运行状态</h2>
            <p className="settings-card-description">
              {status}
              {level === "err" ? "（详见下方日志）" : ""}
            </p>
          </div>
        </div>
        {logText ? (
          <div className="panel-card" style={{ padding: "12px 14px" }}>
            <pre className="app-pre">{logText}</pre>
          </div>
        ) : null}
      </div>

      {pickOpen && (
        <div className="overlay">
          <div className="dialog">
            <h2 className="settings-card-heading">选择要注入的 V5 提示词</h2>
            <p className="settings-card-description">
              {selected?.name} 有两份提示词，按你用的模型选一个；这版只写提示词，不安装任何 skills。
            </p>
            <div className="settings-panel">
              {choices.map((c, i) => (
                <button
                  key={c.file + c.name}
                  type="button"
                  className={cx("settings-row", "app-row-button", i === pickIndex && "app-row-selected")}
                  onClick={() => setPickIndex(i)}
                >
                  <span className="settings-row-copy">
                    <div className="settings-row-title">{c.name}</div>
                    <div className="settings-row-desc">{c.desc}</div>
                  </span>
                  <span className="settings-row-control">{i === pickIndex && <IconCheck size={16} />}</span>
                </button>
              ))}
            </div>
            <div className="app-inline-actions">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={confirmPick}>
                安装 {picked?.name}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setPickOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
