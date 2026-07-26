import { useEffect } from "react";

import { Icon } from "../ui/Icon";

interface KeyCaptureDialogProps {
  readonly actionLabel: string;
  readonly onCancel: () => void;
  readonly onCapture: (code: string | null) => void;
}

export function KeyCaptureDialog({
  actionLabel,
  onCancel,
  onCapture
}: KeyCaptureDialogProps): React.JSX.Element {
  useEffect(() => {
    const capture = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat || event.isComposing) return;
      if (event.code === "Escape") {
        onCancel();
        return;
      }
      if (event.code === "Backspace" || event.code === "Delete") {
        onCapture(null);
        return;
      }
      if (event.code.length > 0) onCapture(event.code);
    };
    window.addEventListener("keydown", capture, true);
    return () => window.removeEventListener("keydown", capture, true);
  }, [onCancel, onCapture]);

  return (
    <div
      aria-labelledby="capture-title"
      aria-modal="true"
      className="capture-overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onCancel();
      }}
      role="dialog"
    >
      <div className="capture-dialog">
        <div className="capture-dialog__pulse">
          <Icon name="keyboard" size={32} />
        </div>
        <h2 id="capture-title">按下新的按键</h2>
        <p>
          正在为「{actionLabel}」监听物理键位。
          同一个键可以绑定多个动作，但会显示冲突提醒。
        </p>
        <div className="capture-dialog__keys">
          <span><kbd>Esc</kbd> 取消</span>
          <span><kbd>Backspace</kbd> 清空</span>
        </div>
      </div>
    </div>
  );
}
