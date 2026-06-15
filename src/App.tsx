import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "@/store/auth";
import { AppShell } from "@/components/layout/AppShell";
import { Loader2 } from "lucide-react";

const Login = lazy(() => import("@/pages/Login"));
const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Visuals = lazy(() => import("@/pages/Visuals"));
const Strategy = lazy(() => import("@/pages/Strategy"));
const History = lazy(() => import("@/pages/History"));
const TradeAnalysis = lazy(() => import("@/pages/TradeAnalysis"));
const EarningsScanner = lazy(() => import("@/pages/EarningsScanner"));

function FullScreenLoader() {
  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
    </div>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) return <FullScreenLoader />;

  return (
    <Suspense fallback={<FullScreenLoader />}>
      <Routes>
        <Route
          path="/login"
          element={user ? <Navigate to="/" replace /> : <Login />}
        />
        {user ? (
          <Route element={<AppShell />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/visuals" element={<Visuals />} />
            <Route path="/strategy" element={<Strategy />} />
            <Route path="/history" element={<History />} />
            <Route path="/analysis" element={<TradeAnalysis />} />
            <Route path="/scanner" element={<EarningsScanner />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        ) : (
          <Route path="*" element={<Navigate to="/login" replace />} />
        )}
      </Routes>
    </Suspense>
  );
}
