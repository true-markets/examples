import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ApiError } from "./api.ts";
import { AppShell } from "./components/AppShell.tsx";
import { Household } from "./pages/Household.tsx";
import { Households } from "./pages/Households.tsx";
import { SignIn } from "./pages/SignIn.tsx";
import { Trade } from "./pages/Trade.tsx";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failures, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && failures < 2,
      refetchOnWindowFocus: false,
      staleTime: 1_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<SignIn />} />
          <Route element={<AppShell />}>
            <Route index element={<Households />} />
            <Route path="/households/:id" element={<Household />} />
            <Route path="/trades/:id" element={<Trade />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
