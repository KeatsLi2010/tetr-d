import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/layout-responsive.css";
import "./styles/settings.css";
import "./styles/settings-handling.css";
import "./styles/settings-responsive.css";
import "./styles/tester.css";
import "./styles/notice.css";
import "./styles/home.css";
import "./styles/arena-shell.css";
import "./styles/duel.css";
import "./styles/garbage-preview.css";
import "./styles/b2b-indicator.css";

const root = document.getElementById("root");
if (root === null) throw new Error("Missing application root.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
