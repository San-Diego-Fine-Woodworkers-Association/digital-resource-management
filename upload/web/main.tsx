import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.tsx";
import { readBoot } from "./boot.ts";
import { createSender } from "./send.ts";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App boot={readBoot(document)} sender={createSender()} />
  </StrictMode>,
);
