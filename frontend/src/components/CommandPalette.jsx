import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Command } from 'cmdk';
import { api } from '../lib/api';
import { useFilters } from '../context/FiltersContext';
import {
  LayoutDashboard, Layers, Package, Users, Store, MapPin, TrendingUp,
  Bell, Clock, Boxes, Target, Factory, FileText, Search, Filter, Calendar,
} from 'lucide-react';

/**
 * Cmd+K command palette.
 *
 * Acciones:
 *  - Navegación: salta a cualquier ruta
 *  - Búsqueda de productos (debounce → /api/productos-odoo/grupos?q=)
 *  - Búsqueda de clientes (debounce → /api/clientes/buscar?q=)
 *  - Filtros rápidos (cambiar período / limpiar)
 *
 * Triggers: Cmd+K (Mac) / Ctrl+K (Win/Linux)
 */

const RUTAS = [
  { to: '/',                label: 'Dashboard',           icon: LayoutDashboard, kw: 'inicio home' },
  { to: '/clasificacion',   label: 'Explorador clasificación', icon: Layers,    kw: 'clasificar productos' },
  { to: '/productos',       label: 'Productos · Ranking', icon: Package,         kw: 'producto top' },
  { to: '/pareto',          label: 'Pareto productos',    icon: Target,          kw: '80/20 pareto' },
  { to: '/clientes',        label: 'Clientes',            icon: Users,           kw: 'cliente top' },
  { to: '/tiendas',         label: 'Tiendas',             icon: Store,           kw: 'sucursal local' },
  { to: '/departamentos',   label: 'Departamentos',       icon: MapPin,          kw: 'region geografia' },
  { to: '/tendencias',      label: 'Tendencias YTD',      icon: TrendingUp,      kw: 'historico años' },
  { to: '/alertas',         label: 'Configuración alertas', icon: Bell,          kw: 'notificacion' },
  { to: '/reservas',        label: 'Reservas pendientes', icon: Clock,           kw: 'pendiente' },
  { to: '/stock',           label: 'Stock',               icon: Boxes,           kw: 'inventario' },
  { to: '/produccion',      label: 'Producción · Pivot',  icon: Factory,         kw: 'producir reposicion' },
  { to: '/reporte-stock',   label: 'Reporte stock detallado', icon: FileText,    kw: 'reporte detalle' },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [productos, setProductos] = useState([]);
  const [clientes, setClientes] = useState([]);
  const [loadingP, setLoadingP] = useState(false);
  const [loadingC, setLoadingC] = useState(false);
  const navigate = useNavigate();
  const { setPeriodo, limpiarTodo } = useFilters();

  // Toggle con Cmd/Ctrl + K
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Debounced backend search (productos + clientes en paralelo)
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setProductos([]); setClientes([]);
      return;
    }
    const t = setTimeout(() => {
      setLoadingP(true); setLoadingC(true);
      api.get('/productos-odoo/grupos', { params: { q, anio_compara: 2025 } })
        .then(r => setProductos((r.data?.items || []).slice(0, 5)))
        .catch(() => setProductos([]))
        .finally(() => setLoadingP(false));
      api.get('/clientes/buscar', { params: { q, limit: 5 } })
        .then(r => setClientes((r.data?.items || r.data || []).slice(0, 5)))
        .catch(() => setClientes([]))
        .finally(() => setLoadingC(false));
    }, 300);
    return () => clearTimeout(t);
  }, [query, open]);

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const go = (to) => {
    navigate(to);
    close();
  };

  const rutasFiltradas = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return RUTAS;
    return RUTAS.filter(r =>
      r.label.toLowerCase().includes(q) ||
      r.kw.toLowerCase().includes(q) ||
      r.to.toLowerCase().includes(q)
    );
  }, [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[15vh]"
         onClick={close}>
      <div className="w-full max-w-xl bg-popover border rounded-lg shadow-2xl overflow-hidden"
           onClick={e => e.stopPropagation()}>
        <Command shouldFilter={false}>
          <div className="flex items-center border-b px-3 py-2 gap-2">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              placeholder="Buscar páginas, productos, clientes..."
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
            />
            <kbd className="text-[10px] text-muted-foreground border rounded px-1.5 py-0.5">ESC</kbd>
          </div>
          <Command.List className="max-h-[60vh] overflow-y-auto p-1">
            <Command.Empty className="py-6 text-center text-xs text-muted-foreground">
              Sin resultados
            </Command.Empty>

            {/* Acciones rápidas */}
            <Command.Group heading="Acciones rápidas" className="px-2 py-1 text-[10px] uppercase text-muted-foreground tracking-wider">
              <Item onSelect={() => { setPeriodo('ytd'); close(); }} icon={Calendar} label="Cambiar a YTD" />
              <Item onSelect={() => { setPeriodo('30'); close(); }} icon={Calendar} label="Cambiar a últimos 30 días" />
              <Item onSelect={() => { setPeriodo('7'); close(); }} icon={Calendar} label="Cambiar a últimos 7 días" />
              <Item onSelect={() => { limpiarTodo(); close(); }} icon={Filter} label="Limpiar todos los filtros" />
            </Command.Group>

            {/* Páginas */}
            {rutasFiltradas.length > 0 && (
              <Command.Group heading="Páginas" className="px-2 py-1 text-[10px] uppercase text-muted-foreground tracking-wider">
                {rutasFiltradas.map(r => (
                  <Item key={r.to} onSelect={() => go(r.to)} icon={r.icon} label={r.label}
                    sub={<span className="text-[10px] text-muted-foreground">{r.to}</span>} />
                ))}
              </Command.Group>
            )}

            {/* Productos (búsqueda backend) */}
            {query.trim().length >= 2 && (
              <Command.Group heading={loadingP ? 'Productos · buscando…' : `Productos (${productos.length})`}
                className="px-2 py-1 text-[10px] uppercase text-muted-foreground tracking-wider">
                {productos.map((p, i) => (
                  <Item key={`p-${p.key || i}`}
                    onSelect={() => go(`/pareto?q=${encodeURIComponent(`${p.marca} ${p.tipo}`)}`)}
                    icon={Package}
                    label={`${p.marca} · ${p.tipo} · ${p.entalle} · ${p.tela}`}
                    sub={<span className="text-[10px] text-muted-foreground">{p.unidades || 0} und · S/ {(p.ventas || 0).toLocaleString('es-PE')}</span>} />
                ))}
              </Command.Group>
            )}

            {/* Clientes (búsqueda backend) */}
            {query.trim().length >= 2 && (
              <Command.Group heading={loadingC ? 'Clientes · buscando…' : `Clientes (${clientes.length})`}
                className="px-2 py-1 text-[10px] uppercase text-muted-foreground tracking-wider">
                {clientes.map((c, i) => (
                  <Item key={`c-${c.cliente_id || i}`}
                    onSelect={() => go(`/clientes?q=${encodeURIComponent(c.nombre || '')}`)}
                    icon={Users}
                    label={c.nombre || c.name || c.cliente_nombre || 'Cliente'}
                    sub={<span className="text-[10px] text-muted-foreground">{c.tickets ? `${c.tickets} compras` : ''}</span>} />
                ))}
              </Command.Group>
            )}
          </Command.List>
          <div className="border-t px-3 py-1.5 text-[10px] text-muted-foreground flex items-center gap-3">
            <span><kbd className="border rounded px-1">↑↓</kbd> navegar</span>
            <span><kbd className="border rounded px-1">↵</kbd> ejecutar</span>
            <span className="ml-auto"><kbd className="border rounded px-1">⌘K</kbd> alternar</span>
          </div>
        </Command>
      </div>
    </div>
  );
}

function Item({ onSelect, icon: Icon, label, sub }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="flex-1 truncate">{label}</span>
      {sub}
    </Command.Item>
  );
}
