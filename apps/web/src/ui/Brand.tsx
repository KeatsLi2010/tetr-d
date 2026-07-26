export function Brand(): React.JSX.Element {
  return (
    <a className="brand" href="/" aria-label="TETR-D 首页">
      <span className="brand__mark" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </span>
      <span>
        <span className="brand__name">TETR/D</span>
        <span className="brand__edition">DUEL SYSTEM // ALPHA</span>
      </span>
    </a>
  );
}
