import "@/App.css";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "./context/ThemeContext";
import { FilterProvider } from "./context/FilterContext";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import SalesAnalysis from "./pages/SalesAnalysis";
import Products from "./pages/Products";
import Stores from "./pages/Stores";
import Clients from "./pages/Clients";
import Asistente from "./pages/Asistente";

function App() {
  return (
    <ThemeProvider>
      <FilterProvider>
        <BrowserRouter>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/" element={<Dashboard />} />
              <Route path="/ventas" element={<SalesAnalysis />} />
              <Route path="/productos" element={<Products />} />
              <Route path="/tiendas" element={<Stores />} />
              <Route path="/clientes" element={<Clients />} />
              <Route path="/asistente" element={<Asistente />} />
            </Route>
          </Routes>
        </BrowserRouter>
      </FilterProvider>
    </ThemeProvider>
  );
}

export default App;
