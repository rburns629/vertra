// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "./AuthContext";

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  // A password someone else set: the server refuses everything but changing
  // it, so that's the only screen offered.
  if (user.mustChangePassword) return <Navigate to="/choose-password" replace />;

  return children;
}
