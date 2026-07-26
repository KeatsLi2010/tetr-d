import type { BufferMode } from "../config/v3/index.ts";

interface BufferModeRowProps {
  readonly title: string;
  readonly help: string;
  readonly value: BufferMode;
  readonly onChange: (value: BufferMode) => void;
}

const modes: readonly { readonly value: BufferMode; readonly label: string }[] = [
  { value: "off", label: "OFF" },
  { value: "hold", label: "HOLD" },
  { value: "tap", label: "TAP" }
];

export function BufferModeRow({
  title,
  help,
  value,
  onChange
}: BufferModeRowProps): React.JSX.Element {
  return (
    <div className="toggle-row">
      <div>
        <span className="toggle-row__title">{title}</span>
        <span className="toggle-row__help">{help}</span>
      </div>
      <div className="buffer-choice" aria-label={title}>
        {modes.map((mode) => (
          <button
            aria-pressed={value === mode.value}
            key={mode.value}
            onClick={() => onChange(mode.value)}
            type="button"
          >
            {mode.label}
          </button>
        ))}
      </div>
    </div>
  );
}
