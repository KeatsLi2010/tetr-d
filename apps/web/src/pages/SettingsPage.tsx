import { useRef, useState } from "react";

import {
  downloadPlayerConfig,
  readPlayerConfigFile
} from "../config/playerConfigFile";
import { usePlayerConfig } from "../config/usePlayerConfig";
import { AppHeader } from "../layout/AppHeader";
import {
  SettingsNav,
  type SettingsSection
} from "../layout/SettingsNav";
import { HandlingPanel } from "../settings/HandlingPanel";
import { HandlingTester } from "../settings/HandlingTester";
import { KeyBindingsPanel } from "../settings/KeyBindingsPanel";
import { Icon } from "../ui/Icon";

function sectionForScroll(): SettingsSection {
  const handling = document.getElementById("handling");
  if (handling === null) return "controls";
  return handling.getBoundingClientRect().top < 180
    ? "handling"
    : "controls";
}

export function SettingsPage(): React.JSX.Element {
  const state = usePlayerConfig();
  const fileInput = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<SettingsSection>("controls");
  const [notice, setNotice] = useState<string | null>(null);

  const selectSection = (next: SettingsSection): void => {
    setSection(next);
    document.getElementById(next)?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  };

  const importFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    try {
      state.replace(await readPlayerConfigFile(file));
      setNotice("配置已导入并保存在本机。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "导入配置失败。");
    } finally {
      if (fileInput.current !== null) fileInput.current.value = "";
    }
  };

  return (
    <div
      className="app-shell"
      onScroll={() => setSection(sectionForScroll())}
    >
      <AppHeader saveState={state.saveState} />
      <div className="page-grid">
        <SettingsNav active={section} onSelect={selectSection} />
        <main className="page-content">
          <header className="page-heading">
            <div>
              <div className="page-heading__eyebrow">
                Local input profile · v3
              </div>
              <h1>让每次输入，都先于网络发生。</h1>
              <p>
                键位和 Handling 只保存在当前浏览器。对局上传的是本地展开后的
                有序操作流，服务器确认永远不会阻塞你的下一次按键。
              </p>
            </div>
            <div className="page-heading__actions">
              <input
                accept="application/json,.json"
                className="sr-only"
                onChange={(event) =>
                  void importFile(event.currentTarget.files?.[0])
                }
                ref={fileInput}
                type="file"
              />
              <button
                className="button"
                onClick={() => fileInput.current?.click()}
                type="button"
              >
                <Icon name="upload" />
                导入
              </button>
              <button
                className="button"
                onClick={() => downloadPlayerConfig(state.config)}
                type="button"
              >
                <Icon name="download" />
                导出
              </button>
              <button
                className="button"
                onClick={() => {
                  if (!window.confirm("恢复全部本地键位和手感默认值？")) return;
                  state.reset();
                  setNotice("已恢复官网参考默认值。");
                }}
                type="button"
              >
                <Icon name="refresh" />
                重置
              </button>
            </div>
          </header>
          {notice !== null && (
            <div className="notice" role="status">
              <span>{notice}</span>
              <button
                aria-label="关闭提示"
                onClick={() => setNotice(null)}
                type="button"
              >
                ×
              </button>
            </div>
          )}
          <div className="content-grid">
            <div className="content-stack">
              <KeyBindingsPanel
                config={state.config}
                onChange={(bindings) =>
                  state.update((config) => ({ ...config, bindings }))
                }
              />
              <HandlingPanel
                handling={state.config.handling}
                onChange={(handling) =>
                  state.update((config) => ({ ...config, handling }))
                }
              />
            </div>
            <HandlingTester config={state.config} />
          </div>
        </main>
      </div>
    </div>
  );
}
