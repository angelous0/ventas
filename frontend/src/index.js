import React from "react";
import ReactDOM from "react-dom/client";
import "@/index.css";
import App from "@/App";

const ro = window.ResizeObserver;
window.ResizeObserver = class extends ro {
  constructor(cb) {
    super((entries, observer) => {
      requestAnimationFrame(() => cb(entries, observer));
    });
  }
};

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
