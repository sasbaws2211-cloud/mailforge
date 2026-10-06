/**
 * Entry point of the standalone admin console (served as admin.html).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import AdminApp from "./AdminApp.js";
import { queryClient } from "./query-client.js";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/quicksand";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("No #root element found");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AdminApp />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
