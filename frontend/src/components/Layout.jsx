import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { Button } from './ui/button';
import SyncStatus from './SyncStatus';
import { GlobalFilterBar } from './GlobalFilterBar';
import { CommandPalette } from './CommandPalette';
import {
  LayoutDashboard,
  Layers,
  Package,
  Users,
  Store,
  MapPin,
  TrendingUp,
  Bell,
  Clock,
  Sun,
  Moon,
  LogOut,
  ShoppingCart,
  Boxes,
  Target,
  Factory,
  FileText,
  Truck,
  Sliders,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';

const navItems = [
  { section: 'VENTAS', items: [
    { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
    { to: '/clasificacion', label: 'Explorador clasificación', icon: Layers },
    { to: '/productos', label: 'Productos', icon: Package },
    { to: '/pareto', label: 'Pareto productos', icon: Target },
    { to: '/clientes', label: 'Clientes', icon: Users },
    { to: '/tiendas', label: 'Tiendas', icon: Store },
    { to: '/departamentos', label: 'Departamentos', icon: MapPin },
    { to: '/tendencias', label: 'Tendencias', icon: TrendingUp },
  ]},
  { section: 'INVENTARIO', items: [
    { to: '/reposicion', label: 'Reposición', icon: Truck },
    { to: '/stock', label: 'Stock', icon: Boxes },
    { to: '/produccion', label: 'Producción · Pivot', icon: Factory },
    { to: '/reporte-stock', label: 'Reporte stock detallado', icon: FileText },
  ]},
  { section: 'RESERVAS', items: [
    { to: '/reservas', label: 'Pendientes', icon: Clock },
  ]},
  { section: 'CONFIG', items: [
    { to: '/config/topes-stock', label: 'Topes de stock', icon: Sliders },
    { to: '/alertas', label: 'Alertas (config)', icon: Bell },
  ]},
];

export const Layout = () => {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('ventas_sidebar_collapsed') === '1');

  useEffect(() => {
    localStorage.setItem('ventas_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const sidebarW = collapsed ? '64px' : '260px';

  return (
    <div className="h-screen grid" style={{ gridTemplateColumns: `${sidebarW} 1fr` }}>
      <aside className="border-r bg-card flex flex-col overflow-hidden transition-[grid-template-columns]">
        <div className="h-14 px-3 flex items-center gap-2 border-b">
          {!collapsed && <ShoppingCart className="h-5 w-5 text-primary shrink-0" />}
          {!collapsed && <span className="font-bold text-base tracking-tight flex-1">Ventas</span>}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(c => !c)}
            className="h-8 w-8 shrink-0"
            title={collapsed ? 'Expandir menú' : 'Colapsar menú'}
          >
            {collapsed ? <PanelLeft className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
          </Button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
          {navItems.map(group => (
            <div key={group.section}>
              {!collapsed && (
                <div className="px-3 py-1 text-[11px] font-semibold text-muted-foreground tracking-wider">
                  {group.section}
                </div>
              )}
              <div className="space-y-0.5">
                {group.items.map(item => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.end}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) => `sidebar-item ${isActive ? 'active' : ''} ${collapsed ? 'justify-center' : ''}`}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {!collapsed && <span className="text-sm">{item.label}</span>}
                  </NavLink>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t">
          {!collapsed && <div className="p-2"><SyncStatus collapsed={false} /></div>}
        </div>
        <div className={`border-t p-3 flex items-center ${collapsed ? 'flex-col gap-1' : 'justify-between'}`}>
          {!collapsed && (
            <div className="text-xs text-muted-foreground truncate">
              {user?.username}
            </div>
          )}
          <div className={`flex items-center gap-1 ${collapsed ? 'flex-col' : ''}`}>
            {collapsed && <SyncStatus collapsed={true} />}
            <Button variant="ghost" size="icon" onClick={toggleTheme} className="h-8 w-8" title="Cambiar tema">
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={handleLogout} className="h-8 w-8" title="Cerrar sesión">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>
      <main className="overflow-auto flex flex-col">
        <GlobalFilterBar />
        <div className="flex-1">
          <Outlet />
        </div>
      </main>
      <CommandPalette />
    </div>
  );
};
