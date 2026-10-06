/**
 * Root component of the standalone admin console (admin.html).
 *
 * A small app of its own: a sign-in page and the console pages, nothing of the
 * customer dashboard. Which session you have is decided by one call to
 * /admin-auth/me; a 401 is the normal signed-out state.
 *
 * Routes:
 *   /login            sign-in
 *   /admin, /admin/*  the console (same paths as the console embedded in the customer app)
 *   anything else     back to the console
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { Navigate, Route, Routes } from "react-router-dom";
import { useAdminMe } from "./admin-auth.js";
import AdminLoginPage from "./pages/admin/AdminLoginPage.js";
import { StandaloneAdminLayout } from "./pages/admin/AdminLayout.js";
import AdminPage from "./pages/admin/AdminPage.js";
import AdminAuditPage from "./pages/admin/AdminAuditPage.js";
import AdminAiPage from "./pages/admin/AdminAiPage.js";
import AdminSecurityPage from "./pages/admin/AdminSecurityPage.js";
import AdminTenantPage from "./pages/admin/AdminTenantPage.js";
import NotFoundPage from "./pages/NotFoundPage.js";

export default function AdminApp() {
  const { data: me, isLoading, isError } = useAdminMe();
  if (isLoading) return null;

  if (isError) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6 text-center">
        <div>
          <h1 className="text-xl font-semibold text-foreground">The admin console could not be reached</h1>
          <p className="mt-2 text-[15px] text-muted-foreground">Check your connection and reload the page.</p>
        </div>
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={me ? <Navigate to="/admin" replace /> : <AdminLoginPage />} />
      <Route path="/admin" element={me ? <StandaloneAdminLayout me={me} /> : <Navigate to="/login" replace />}>
        <Route index element={<AdminPage />} />
        <Route path="ai" element={<AdminAiPage />} />
        <Route path="audit" element={<AdminAuditPage />} />
        <Route path="security" element={<AdminSecurityPage />} />
        <Route path="tenants/:id" element={<AdminTenantPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
      <Route path="*" element={<Navigate to={me ? "/admin" : "/login"} replace />} />
    </Routes>
  );
}
