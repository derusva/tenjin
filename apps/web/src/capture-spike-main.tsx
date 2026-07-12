import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";

import { createBrowserCaptureSpikeReaderDependencies } from "./features/capture-spike/captureSpikeBrowser.js";
import { CaptureSpikeDiagnostic } from "./features/capture-spike/CaptureSpikeDiagnostic.js";
import "./styles/tokens.css";
import "./styles/app.css";

registerSW({ immediate: true });

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("Tenjin capture diagnostic root element is missing");
}

createRoot(rootElement).render(
  <CaptureSpikeDiagnostic
    ledgerHref={import.meta.env.BASE_URL}
    readerDependencies={createBrowserCaptureSpikeReaderDependencies()}
  />,
);
