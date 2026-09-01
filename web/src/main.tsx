import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { App } from "./app.tsx";

/**
 * The mount, and nothing else.
 *
 * StrictMode is on deliberately rather than by scaffold default: it double-invokes effects, which is
 * precisely the pressure the Agent Session view registry is built to survive. A view owned by a
 * component would be disposed and recreated by that double mount, and each disposal replays a whole
 * Presentation Transcript from seq 0 — so if StrictMode is quiet here, the ref-counted registry and
 * its grace period are doing their job.
 */
const mount = document.getElementById("root");
if (!mount) throw new Error("index.html is missing #root");

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
