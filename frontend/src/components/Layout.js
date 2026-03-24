import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, TrendingUp, Package, Store, Users, Sun, Moon, X } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useFilters } from '../context/FilterContext';
import { Button } from '../components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '../components/ui/select';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/ventas', icon: TrendingUp, label: 'Ventas' },
  { to: '/productos', icon: Package, label: 'Productos' },
  { to: '/tiendas', icon: Store, label: 'Tiendas' },
  { to: '/clientes', icon: Users, label: 'Clientes' },
];

export default function Layout() {
  const { theme, toggleTheme } = useTheme();
  const { options, filters, setFilter, clearFilters } = useFilters();
  const hasFilters = filters.marca || filters.tipo || filters.store;

  return (
    <div className="flex h-screen bg-background" data-testid="app-layout">
      {/* Sidebar */}
      <aside className="w-[220px] border-r border-border bg-background flex flex-col shrink-0" data-testid="sidebar">
        <div className="p-5 border-b border-border">
          <h1 className="font-heading text-base font-black tracking-tight leading-none">AMBISSION</h1>
          <p className="text-[10px] tracking-[0.25em] text-muted-foreground font-semibold mt-1.5 uppercase">CRM Reports</p>
        </div>
        <nav className="flex-1 p-2 space-y-0.5" data-testid="sidebar-nav">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              data-testid={`nav-${item.label.toLowerCase()}`}
              className={({ isActive }) =>
                `nav-link flex items-center gap-2.5 px-3 py-2 rounded-sm text-sm ${
                  isActive
                    ? 'bg-foreground text-background font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                }`
              }
            >
              <item.icon size={16} />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-border">
          <p className="text-[10px] text-muted-foreground tracking-wide">Ambission Industries S.A.C.</p>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <header
          className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur-md px-6 py-2.5 flex items-center gap-2.5"
          data-testid="header"
        >
          <Select
            value={filters.marca || "all"}
            onValueChange={(v) => setFilter('marca', v === 'all' ? null : v)}
          >
            <SelectTrigger className="w-[150px] h-8 text-xs rounded-sm" data-testid="filter-marca">
              <SelectValue placeholder="Marca" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las marcas</SelectItem>
              {options.marcas.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select
            value={filters.tipo || "all"}
            onValueChange={(v) => setFilter('tipo', v === 'all' ? null : v)}
          >
            <SelectTrigger className="w-[150px] h-8 text-xs rounded-sm" data-testid="filter-tipo">
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los tipos</SelectItem>
              {options.tipos.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
            </SelectContent>
          </Select>

          <Select
            value={filters.store || "all"}
            onValueChange={(v) => setFilter('store', v === 'all' ? null : v)}
          >
            <SelectTrigger className="w-[140px] h-8 text-xs rounded-sm" data-testid="filter-store">
              <SelectValue placeholder="Tienda" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas las tiendas</SelectItem>
              {options.stores.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
            </SelectContent>
          </Select>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearFilters}
              className="h-8 text-xs rounded-sm px-2"
              data-testid="clear-filters-btn"
            >
              <X size={14} className="mr-1" /> Limpiar
            </Button>
          )}

          <div className="flex-1" />

          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            className="h-8 w-8 rounded-sm"
            data-testid="theme-toggle-btn"
          >
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </Button>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-auto p-6" data-testid="main-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
