interface ToggleRowProps {
  readonly title: string;
  readonly help: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
}

export function ToggleRow({
  title,
  help,
  value,
  onChange
}: ToggleRowProps): React.JSX.Element {
  return (
    <div className="toggle-row">
      <div>
        <span className="toggle-row__title">{title}</span>
        <span className="toggle-row__help">{help}</span>
      </div>
      <button
        aria-label={title}
        aria-pressed={value}
        className="toggle"
        onClick={() => onChange(!value)}
        type="button"
      />
    </div>
  );
}
