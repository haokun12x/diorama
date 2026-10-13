import React from "react";
import { createRoot } from "react-dom/client";
import "./app/style.css";
const root = document.getElementById("root")!;
try {
  const { App } = await import("./app/App");
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  const heading = document.createElement("h1");
  heading.textContent = "The WASM kernel could not start.";
  const detail = document.createElement("p");
  detail.textContent = error instanceof Error ? error.message : String(error);
  const retry = document.createElement("button");
  retry.className = "primary";
  retry.textContent = "Retry initialization";
  retry.onclick = () => location.reload();
  root.replaceChildren(heading, detail, retry);
}
