import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { MapPicker } from "./MapPicker";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname === "/map-picker" ? <MapPicker /> : <App />}
  </StrictMode>,
);
