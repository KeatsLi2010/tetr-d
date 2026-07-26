import { HomePage } from "./pages/HomePage";
import { DuelPage } from "./pages/DuelPage.tsx";
import { SoloPage } from "./pages/SoloPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App(): React.JSX.Element {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  if (path === "/play/solo") return <SoloPage />;
  if (path === "/play/duel") return <DuelPage />;
  if (path === "/config" || path === "/settings") return <SettingsPage />;
  return <HomePage />;
}
