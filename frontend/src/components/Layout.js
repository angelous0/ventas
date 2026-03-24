import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, TrendingUp, Package, Store, Users, Sun, Moon, X } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';
import { useFilters } from '../context/FilterContext';
import { Button } from '../components/ui/button';
import { MultiSelect } from '../components/MultiSelect';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/ventas', icon: TrendingUp, label: 'Ventas' },
  { to: '/productos', icon: Package, label: 'Productos' },
  { to: '/tiendas', icon: Store, label: 'Tiendas' },
  { to: '/clientes', icon: Users, label: 'Clientes' },
];

export default function Layout() {
  const { theme, toggleTheme } = useTheme();
  const { options, filters, setFilterArray, clearFilters, hasFilters } = useFilters();

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
          <p className="text-[9px] text-muted-foreground/60 mt-0.5">Solo ventas reales (sin cancelaciones ni reservas)</p>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        {/* Header */}
        <header
          className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur-md px-6 py-2.5 flex items-center gap-2"
          data-testid="header"
        >
          <MultiSelect
            options={options.marcas}
            selected={filters.marcas}
            onChange={(v) => setFilterArray('marcas', v)}
            placeholder="Marca"
            testId="filter-marca"
          />
          <MultiSelect
            options={options.tipos}
            selected={filters.tipos}
            onChange={(v) => setFilterArray('tipos', v)}
            placeholder="Tipo"
            testId="filter-tipo"
          />
          <MultiSelect
            options={options.stores}
            selected={filters.stores}
            onChange={(v) => setFilterArray('stores', v)}
            placeholder="Tienda"
            testId="filter-store"
          />

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
