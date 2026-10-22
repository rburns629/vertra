// SPDX-License-Identifier: MIT
import { lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { AppLayout } from "./layout/AppLayout";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

// Each signed-in page is its own chunk, fetched the first time it's opened
// (AppLayout shows a spinner meanwhile): the Docs page alone brings mermaid,
// and the home page recharts, which nobody should download just to log in.
const AccountPage = lazy(() => import("./pages/AccountPage").then((m) => ({ default: m.AccountPage })));
const ApiPage = lazy(() => import("./pages/ApiPage").then((m) => ({ default: m.ApiPage })));
const ApisPage = lazy(() => import("./pages/ApisPage").then((m) => ({ default: m.ApisPage })));
const AdminPage = lazy(() => import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const DocsPage = lazy(() => import("./pages/DocsPage").then((m) => ({ default: m.DocsPage })));
const ExecutionDetailPage = lazy(() => import("./pages/ExecutionDetailPage").then((m) => ({ default: m.ExecutionDetailPage })));
const ExecutionsListPage = lazy(() => import("./pages/ExecutionsListPage").then((m) => ({ default: m.ExecutionsListPage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const ProductsPage = lazy(() => import("./pages/ProductsPage").then((m) => ({ default: m.ProductsPage })));
const RunPage = lazy(() => import("./pages/RunPage").then((m) => ({ default: m.RunPage })));
const SubmitExecutionPage = lazy(() => import("./pages/SubmitExecutionPage").then((m) => ({ default: m.SubmitExecutionPage })));
const TeamPage = lazy(() => import("./pages/TeamPage").then((m) => ({ default: m.TeamPage })));
const TeamsPage = lazy(() => import("./pages/TeamsPage").then((m) => ({ default: m.TeamsPage })));

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<HomePage />} />
          <Route path="/teams" element={<TeamsPage />} />
          <Route path="/teams/:teamName" element={<TeamPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/account" element={<AccountPage />} />
          <Route path="/executions" element={<ExecutionsListPage />} />
          <Route path="/executions/submit" element={<SubmitExecutionPage />} />
          <Route path="/executions/:id" element={<ExecutionDetailPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/run" element={<RunPage />} />
          <Route path="/apis" element={<ApisPage />} />
          <Route path="/apis/:team/:name" element={<ApiPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/docs/:id" element={<DocsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
