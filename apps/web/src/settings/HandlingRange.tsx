import type { CSSProperties } from "react";

interface HandlingRangeProps {
  readonly ariaLabel: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
  readonly primary: string;
  readonly secondary: string;
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly onChange: (value: number) => void;
}

export function HandlingRange({
  ariaLabel,
  value,
  min,
  max,
  step = 1,
  primary,
  secondary,
  leftLabel,
  rightLabel,
  onChange
}: HandlingRangeProps): React.JSX.Element {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <div className="handling-control">
      <div className="handling-control__readout">
        <span className="handling-control__value">
          {primary}
          <small>{secondary}</small>
        </span>
      </div>
      <input
        aria-label={ariaLabel}
        className="range"
        max={max}
        min={min}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        step={step}
        style={{ "--range-fill": `${fill}%` } as CSSProperties}
        type="range"
        value={value}
      />
      <div className="handling-control__ends">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </div>
    </div>
  );
}
