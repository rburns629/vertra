// SPDX-License-Identifier: MIT
import { lazy } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { AuthProvider } from "./auth/AuthContext";
import { EnvironmentProvider } from "./environment";
import { ProtectedRoute } from "./auth/ProtectedRoute";
import { NotFoundPage } from "./components/ErrorPage";
import { AppLayout } from "./layout/AppLayout";
import { ChoosePasswordPage } from "./pages/ChoosePasswordPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";

// Each signed-in page is its own chunk, fetched the first time it's opened
// (AppLayout shows a spinner meanwhile): the Docs page alone brings mermaid,
// and Observe's metrics recharts, which nobody should download just to log in.
const AccountPage = lazy(() => import("./pages/AccountPage").then((m) => ({ default: m.AccountPage })));
const ObservePage = lazy(() => import("./pages/ObservePage").then((m) => ({ default: m.ObservePage })));
const ApiPage = lazy(() => import("./pages/ApiPage").then((m) => ({ default: m.ApiPage })));
const ApisPage = lazy(() => import("./pages/ApisPage").then((m) => ({ default: m.ApisPage })));
const AdminPage = lazy(() => import("./pages/AdminPage").then((m) => ({ default: m.AdminPage })));
const DocsPage = lazy(() => import("./pages/DocsPage").then((m) => ({ default: m.DocsPage })));
const ExecutionDetailPage = lazy(() => import("./pages/ExecutionDetailPage").then((m) => ({ default: m.ExecutionDetailPage })));
const ExecutionsListPage = lazy(() => import("./pages/ExecutionsListPage").then((m) => ({ default: m.ExecutionsListPage })));
const HomePage = lazy(() => import("./pages/HomePage").then((m) => ({ default: m.HomePage })));
const ProductsPage = lazy(() => import("./pages/ProductsPage").then((m) => ({ default: m.ProductsPage })));
const RunFormPage = lazy(() => import("./pages/RunFormPage").then((m) => ({ default: m.RunFormPage })));
const CatalogPage = lazy(() => import("./pages/CatalogPage").then((m) => ({ default: m.CatalogPage })));
const SubmitExecutionPage = lazy(() => import("./pages/SubmitExecutionPage").then((m) => ({ default: m.SubmitExecutionPage })));
const TeamPage = lazy(() => import("./pages/TeamPage").then((m) => ({ default: m.TeamPage })));
const TeamsPage = lazy(() => import("./pages/TeamsPage").then((m) => ({ default: m.TeamsPage })));

/** A page that moved: the same id, query and anchor at its new address. */
function Moved({ to }: { to: string }) {
  const params = useParams();
  const { search, hash } = useLocation();
  const path = to.replace(/:(\w+)/g, (_, name: string) => encodeURIComponent(params[name] ?? ""));
  return <Navigate to={path + search + hash} replace />;
}

export function App() {
  return (
    <EnvironmentProvider>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/choose-password" element={<ChoosePasswordPage />} />
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
            <Route path="/runs" element={<ExecutionsListPage />} />
            <Route path="/runs/submit" element={<SubmitExecutionPage />} />
            <Route path="/runs/:id" element={<ExecutionDetailPage />} />
            <Route path="/catalog" element={<CatalogPage />} />
            <Route path="/catalog/run" element={<RunFormPage />} />
            <Route path="/products" element={<ProductsPage />} />
            <Route path="/apis" element={<ApisPage />} />
            <Route path="/observe" element={<ObservePage />} />
            <Route path="/apis/:team/:name" element={<ApiPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/docs/:id" element={<DocsPage />} />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
          {/* Where pages used to be, for bookmarks and old links. */}
          <Route path="/executions" element={<Moved to="/runs" />} />
          <Route path="/executions/submit" element={<Moved to="/runs/submit" />} />
          <Route path="/executions/:id" element={<Moved to="/runs/:id" />} />
          <Route path="/run" element={<Moved to="/catalog" />} />
        </Routes>
      </AuthProvider>
    </EnvironmentProvider>
  );
}
