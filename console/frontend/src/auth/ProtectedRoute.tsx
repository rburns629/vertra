// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  // A password someone else set: the server refuses everything but changing
  // it, so the account page is the only one that works.
  if (user.mustChangePassword && location.pathname !== "/account") return <Navigate to="/account" replace />;

  return children;
}
