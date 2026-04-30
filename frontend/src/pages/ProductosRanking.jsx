import { useEffect, useState, useCallback } from 'react';
import { api, formatSoles, formatNum, formatPct } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Loader2, Package, Search, ChevronDown, ChevronRight, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import ProductoOdooModal from '../components/ProductoOdooModal';
import { useFilters } from '../context/FiltersContext';

const ESTADO_COLORS = {
  pendiente: 'bg-amber-100 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  parcial: 'bg-blue-100 text-blue-800 dark:bg-blue-950/40 dark:text-blue-300',
  completo: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300',
  excluido: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
};

export default function ProductosRanking() {
  // Filtros marca/tipo/tiendas vienen del FiltersContext
  const { filters } = useFilters();
  const [grupos, setGrupos] = useState([]);
  const [totalVentas, setTotalVentas] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(''); // búsqueda local (no se globaliza)

  const [grupoExpandido, setGrupoExpandido] = useState(null);
  const [detalleItems, setDetalleItems] = useState({});
  const [detalleLoading, setDetalleLoading] = useState({});
  const [editando, setEditando] = useState(null);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const params = { anio_compara: 2025 };
      // /productos-odoo/grupos soporta CSV en marca_id/tipo_id/tienda (ANY).
      if (filters.marcas.length) params.marca_id = filters.marcas.join(',');
      if (filters.tipos.length) params.tipo_id = filters.tipos.join(',');
      if (filters.tiendas.length) params.tienda = filters.tiendas.join(',');
      const res = await api.get('/productos-odoo/grupos', { params });
      setGrupos(res.data.items || []);
      setTotalVentas(res.data.total_ventas || 0);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [filters.marcas, filters.tipos, filters.tiendas]);

  useEffect(() => { cargar(); }, [cargar]);

  const abrirDetalle = async (grupo) => {
    if (grupoExpandido === grupo.key) {
      setGrupoExpandido(null);
      return;
    }
    setGrupoExpandido(grupo.key);
    if (!detalleItems[grupo.key]) {
      setDetalleLoading(prev => ({ ...prev, [grupo.key]: true }));
      try {
        const res = await api.get('/productos-odoo/grupo-detalle', {
          params: {
            marca_id: grupo.marca_id,
            tipo_id: grupo.tipo_id,
            entalle_id: grupo.entalle_id,
            tela_id: grupo.tela_id,
          },
        });
        setDetalleItems(prev => ({ ...prev, [grupo.key]: res.data.items || [] }));
      } catch (e) {
        toast.error('Error al cargar detalle');
      } finally {
        setDetalleLoading(prev => ({ ...prev, [grupo.key]: false }));
      }
    }
  };

  const gruposFiltrados = q.trim()
    ? grupos.filter(g => {
        const txt = `${g.marca} ${g.tipo} ${g.entalle} ${g.tela}`.toLowerCase();
        return txt.includes(q.toLowerCase().trim());
      })
    : grupos;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Package className="h-6 w-6 text-primary" /> Productos
        </h1>
        <p className="text-sm text-muted-foreground">
          Agrupado por <span className="font-medium">marca · tipo · entalle · tela</span> — YTD 2026 ·
          <span className="font-semibold text-foreground ml-1">{grupos.length}</span> combinaciones ·
          Total <span className="font-semibold text-foreground">{formatSoles(totalVentas)}</span>
        </p>
      </div>

      {/* Búsqueda local — los filtros marca/tipo/tienda están en la barra global */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Buscar marca/tipo/entalle/tela..." value={q} onChange={e => setQ(e.target.value)} className="pl-9" />
      </div>

      {/* Tabla de grupos */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64"><Loader2 className="h-8 w-8 animate-spin" /></div>
          ) : (
            <div className="overflow-auto max-h-[calc(100vh-260px)]">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                  <tr>
                    <th className="w-8"></th>
                    <th className="text-left py-2 px-3">Marca</th>
                    <th className="text-left py-2 px-3">Tipo</th>
                    <th className="text-left py-2 px-3">Entalle</th>
                    <th className="text-left py-2 px-3">Tela</th>
                    <th className="text-right py-2 px-3">Productos</th>
                    <th className="text-right py-2 px-3">Ventas</th>
                    <th className="text-right py-2 px-3">Unidades</th>
                    <th className="text-right py-2 px-3">Tickets</th>
                    <th className="text-right py-2 px-3">Share</th>
                    <th className="text-right py-2 px-3">vs 2025</th>
                  </tr>
                </thead>
                <tbody>
                  {gruposFiltrados.map(g => {
                    const abierto = grupoExpandido === g.key;
                    const detalle = detalleItems[g.key];
                    const loadingDet = detalleLoading[g.key];
                    return (
                      <>
                        <tr
                          key={g.key}
                          className="border-b hover:bg-muted/20 cursor-pointer"
                          onClick={() => abrirDetalle(g)}
                        >
                          <td className="py-2 px-2 text-muted-foreground">
                            {abierto ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </td>
                          <td className="py-2 px-3 font-medium">{g.marca}</td>
                          <td className="py-2 px-3">{g.tipo}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.entalle}</td>
                          <td className="py-2 px-3 text-muted-foreground">{g.tela}</td>
                          <td className="text-right tabular-nums py-2 px-3 text-xs">{g.productos}</td>
                          <td className="text-right tabular-nums py-2 px-3 font-medium">{formatSoles(g.ventas)}</td>
                          <td className="text-right tabular-nums py-2 px-3">{formatNum(g.unidades)}</td>
                          <td className="text-right tabular-nums py-2 px-3">{formatNum(g.tickets)}</td>
                          <td className="text-right tabular-nums py-2 px-3">{g.share_pct}%</td>
                          <td className={`text-right tabular-nums py-2 px-3 font-medium ${g.var_pct == null ? 'text-muted-foreground' : g.var_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {g.var_pct == null ? '—' : formatPct(g.var_pct)}
                          </td>
                        </tr>
                        {abierto && (
                          <tr key={g.key + '-detail'}>
                            <td colSpan={11} className="bg-muted/20 p-0">
                              {loadingDet ? (
                                <div className="flex items-center justify-center h-24"><Loader2 className="h-5 w-5 animate-spin" /></div>
                              ) : detalle && detalle.length > 0 ? (
                                <div className="px-4 py-3">
                                  <div className="text-xs text-muted-foreground mb-2">
                                    {detalle.length} producto{detalle.length !== 1 ? 's' : ''} en este grupo:
                                  </div>
                                  <table className="w-full text-xs">
                                    <thead className="text-muted-foreground border-b">
                                      <tr>
                                        <th className="text-left py-1.5 px-2">Producto</th>
                                        <th className="text-left py-1.5 px-2">Estado</th>
                                        <th className="text-right py-1.5 px-2">Stock</th>
                                        <th className="text-right py-1.5 px-2">Ventas</th>
                                        <th className="text-right py-1.5 px-2">Und</th>
                                        <th className="text-right py-1.5 px-2">Tkts</th>
                                        <th className="w-8"></th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {detalle.map(p => (
                                        <tr key={p.product_tmpl_id} className="border-b border-muted/40 hover:bg-background/50">
                                          <td className="py-1.5 px-2 font-medium">{p.nombre || `template ${p.product_tmpl_id}`}</td>
                                          <td className="py-1.5 px-2">
                                            {p.estado ? <Badge variant="outline" className={`${ESTADO_COLORS[p.estado] || ''} text-[10px]`}>{p.estado}</Badge> : <span className="text-muted-foreground">—</span>}
                                          </td>
                                          <td className="text-right tabular-nums py-1.5 px-2">{formatNum(p.odoo_stock_actual)}</td>
                                          <td className="text-right tabular-nums py-1.5 px-2 font-medium">{formatSoles(p.ventas)}</td>
                                          <td className="text-right tabular-nums py-1.5 px-2">{formatNum(p.unidades)}</td>
                                          <td className="text-right tabular-nums py-1.5 px-2">{p.tickets}</td>
                                          <td className="py-1.5 px-2">
                                            {p.enriq_id && (
                                              <Button
                                                size="icon" variant="ghost" className="h-6 w-6"
                                                onClick={(e) => { e.stopPropagation(); setEditando(p); }}
                                              >
                                                <Pencil className="h-3 w-3" />
                                              </Button>
                                            )}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              ) : (
                                <div className="text-center text-xs text-muted-foreground py-3">Sin productos con ventas en este grupo</div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
              {gruposFiltrados.length === 0 && <div className="p-6 text-center text-muted-foreground text-sm">Sin grupos que coincidan</div>}
            </div>
          )}
        </CardContent>
      </Card>

      {editando && (
        <ProductoOdooModal
          producto={{
            id: editando.enriq_id,
            odoo_nombre: editando.nombre,
            odoo_stock_actual: editando.odoo_stock_actual,
            estado: editando.estado,
            campos_pendientes: editando.campos_pendientes || [],
            marca_id: editando.marca_id,
            tipo_id: editando.tipo_id,
            entalle_id: editando.entalle_id,
            tela_id: editando.tela_id,
            tela_general_id: editando.tela_general_id,
            genero_id: editando.genero_id,
            cuello_id: editando.cuello_id,
            detalle_id: editando.detalle_id,
            lavado_id: editando.lavado_id,
            notas: editando.notas,
            odoo_marca_texto: editando.odoo_marca_texto,
            odoo_tipo_texto: editando.odoo_tipo_texto,
            odoo_entalle_texto: editando.odoo_entalle_texto,
            odoo_tela_texto: editando.odoo_tela_texto,
          }}
          onClose={() => setEditando(null)}
          onSaved={() => {
            cargar();
            setEditando(null);
            setDetalleItems({}); // invalidar caché para recargar detalle
          }}
        />
      )}
    </div>
  );
}
