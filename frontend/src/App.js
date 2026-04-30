import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "./components/ui/sonner";
import { ThemeProvider } from "./context/ThemeContext";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { FiltersProvider } from "./context/FiltersContext";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import ExploradorClasificacion from "./pages/ExploradorClasificacion";
import ProductosRanking from "./pages/ProductosRanking";
import ProductoDetalle from "./pages/ProductoDetalle";
import Clientes from "./pages/Clientes";
import Tiendas from "./pages/Tiendas";
import Departamentos from "./pages/Departamentos";
import Tendencias from "./pages/Tendencias";
import AlertasConfig from "./pages/AlertasConfig";
import ReservasPendientes from "./pages/ReservasPendientes";
import Stock from "./pages/Stock";
import Reposicion from "./pages/Reposicion";
import ParetoProductos from "./pages/ParetoProductos";
import Produccion from "./pages/Produccion";
import ReporteStockDetallado from "./pages/ReporteStockDetallado";
import ConfigTopesStock from "./pages/ConfigTopesStock";
import { Loader2 } from "lucide-react";

const Protected = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return children;
};

const Public = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <div className="min-h-screen flex items-center justify-center bg-background"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  if (isAuthenticated) return <Navigate to="/" replace />;
  return children;
};

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Public><Login /></Public>} />
      <Route path="/" element={<Protected><FiltersProvider><Layout /></FiltersProvider></Protected>}>
        <Route index element={<Dashboard />} />
        <Route path="clasificacion" element={<ExploradorClasificacion />} />
        <Route path="productos" element={<ProductosRanking />} />
        <Route path="productos/:id" element={<ProductoDetalle />} />
        <Route path="clientes" element={<Clientes />} />
        <Route path="tiendas" element={<Tiendas />} />
        <Route path="departamentos" element={<Departamentos />} />
        <Route path="tendencias" element={<Tendencias />} />
        <Route path="alertas" element={<AlertasConfig />} />
        <Route path="reservas" element={<ReservasPendientes />} />
        <Route path="reposicion" element={<Reposicion />} />
        <Route path="stock" element={<Stock />} />
        <Route path="pareto" element={<ParetoProductos />} />
        <Route path="produccion" element={<Produccion />} />
        <Route path="reporte-stock" element={<ReporteStockDetallado />} />
        <Route path="config/topes-stock" element={<ConfigTopesStock />} />
      </Route>
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
        <Toaster position="top-right" richColors />
      </AuthProvider>
    </ThemeProvider>
  );
}
