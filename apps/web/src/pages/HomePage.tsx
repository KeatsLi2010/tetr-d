import { Brand } from "../ui/Brand";

export function HomePage(): React.JSX.Element {
  return (
    <div className="home-shell">
      <header className="home-header">
        <Brand />
        <div className="home-header__status">
          <span className="status-pulse" />
          LOCAL FIRST
        </div>
      </header>

      <main className="home-main">
        <section className="home-hero">
          <div className="home-hero__eyebrow">TETR/D · DUEL FOUNDATION</div>
          <h1>先在本地练熟，<br />再进入房间。</h1>
          <p>
            单人模式和未来双人房间共享同一套棋盘、SRS+、
            7-Bag 与输入系统。练习无需联网，也不会上传你的配置。
          </p>
        </section>

        <section className="mode-grid" aria-label="游戏模式">
          <a className="mode-card mode-card--primary" href="/play/solo">
            <div className="mode-card__topline">
              <span>01 / LOCAL</span>
              <span className="mode-card__state">READY</span>
            </div>
            <div className="mode-card__symbol">1P</div>
            <h2>单人练习</h2>
            <p>无限生存 · 本地 240Hz 模拟 · 即时 Handling</p>
            <div className="mode-card__cta">开始练习 <span>→</span></div>
          </a>

          <a className="mode-card mode-card--network" href="/play/duel">
            <div className="mode-card__topline">
              <span>02 / NETWORK</span>
              <span className="mode-card__state">READY</span>
            </div>
            <div className="mode-card__symbol">2P</div>
            <h2>双人房间</h2>
            <p>共享 7-Bag · 服务端裁决 · 本地预测</p>
            <div className="mode-card__cta">创建或加入房间 <span>→</span></div>
          </a>

          <a className="mode-card mode-card--config" href="/config">
            <div className="mode-card__topline">
              <span>03 / LOCAL PROFILE</span>
              <span className="mode-card__state">V3</span>
            </div>
            <div className="mode-card__symbol">CFG</div>
            <h2>操作配置</h2>
            <p>键盘绑定 · DAS / ARR / DCD / SDF · 本地保存</p>
            <div className="mode-card__cta">调整配置 <span>→</span></div>
          </a>
        </section>
      </main>

      <footer className="home-footer">
        <span>TETR/D ALPHA</span>
        <span>CONFIG + SOLO DATA STAY ON THIS DEVICE</span>
      </footer>
    </div>
  );
}
