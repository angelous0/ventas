import { useEffect, useState, useCallback } from 'react';
import { api, formatSoles, formatNum, formatPct } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Loader2, Store, Target } from 'lucide-react';
import { toast } from 'sonner';
import { useFilters } from '../context/FiltersContext';

export default function Tiendas() {
  const { filters } = useFilters();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      // Tiendas usa el período del FiltersContext (vista=ytd|7|30) y anio_compara fijo
      const vista = filters.periodo === '12m' ? 'ytd' : filters.periodo;
      const res = await api.get('/tiendas/ventas', { params: { vista, anio_compara: 2025 } });
      setItems(res.data.items || []);
      setTotal(res.data.total_ventas || 0);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [filters.periodo]);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return (
    <div className="p-6 space-y-5">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-96 w-full" />
    </div>
  );

  const maxVentas = Math.max(...items.map(i => i.ventas), 1);
  // Umbral 80/20: última tienda que está dentro del 80% acumulado
  const idx80 = items.findIndex(i => i.acumulado_pct >= 80);
  const tiendasVitales = idx80 === -1 ? items.length : idx80 + 1;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Store className="h-6 w-6 text-primary" /> Tiendas — Pareto
        </h1>
        <p className="text-sm text-muted-foreground">
          YTD 2026 · {items.length} tiendas · Total <span className="font-semibold text-foreground">{formatSoles(total)}</span>
        </p>
      </div>

      {/* Banner 80/20 */}
      {idx80 !== -1 && (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="p-4 flex items-start gap-3">
            <Target className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div className="text-sm">
              <span className="font-semibold">{tiendasVitales} tienda{tiendasVitales !== 1 ? 's' : ''}</span> concentran el <span className="font-semibold">80%</span> de las ventas
              ({formatSoles(items.slice(0, tiendasVitales).reduce((s, it) => s + it.ventas, 0))}).
              Las otras {items.length - tiendasVitales} aportan el 20% restante.
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tabla Pareto */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pareto de ventas</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="text-left py-2 px-3 w-8">#</th>
                  <th className="text-left py-2 px-3">Tienda</th>
                  <th className="text-left py-2 px-3 w-[35%]">Distribución</th>
                  <th className="text-right py-2 px-3">Ventas</th>
                  <th className="text-right py-2 px-3">Share</th>
                  <th className="text-right py-2 px-3">Acumulado</th>
                  <th className="text-right py-2 px-3">Tickets</th>
                  <th className="text-right py-2 px-3">Tkt Prom</th>
                  <th className="text-right py-2 px-3">Clientes</th>
                  <th className="text-right py-2 px-3">vs 2025</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const destacada = i < tiendasVitales;
                  return (
                    <tr key={it.tienda} className={`border-b hover:bg-muted/20 ${destacada ? 'bg-primary/5' : ''}`}>
                      <td className="py-2 px-3 text-muted-foreground font-mono text-xs">{i + 1}</td>
                      <td className="py-2 px-3 font-medium">
                        {it.tienda}
                        {it.location_ids && it.location_ids.length > 1 && (
                          <span className="ml-2 text-[10px] text-muted-foreground">
                            ({it.location_ids.length} ubicaciones)
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        <div className="relative h-5">
                          {/* Barra de share */}
                          <div className="absolute inset-y-0 left-0 bg-primary/70 rounded-sm" style={{ width: `${(it.ventas / maxVentas) * 100}%` }} />
                          {/* Línea de acumulado */}
                          <div className="absolute top-0 bottom-0 border-r-2 border-amber-500 dark:border-amber-400"
                               style={{ left: `${it.acumulado_pct}%` }} title={`Acumulado: ${it.acumulado_pct}%`} />
                        </div>
                      </td>
                      <td className="text-right tabular-nums py-2 px-3 font-medium">{formatSoles(it.ventas)}</td>
                      <td className="text-right tabular-nums py-2 px-3">{it.share_pct}%</td>
                      <td className={`text-right tabular-nums py-2 px-3 font-semibold ${destacada ? 'text-primary' : 'text-muted-foreground'}`}>
                        {it.acumulado_pct}%
                      </td>
                      <td className="text-right tabular-nums py-2 px-3">{formatNum(it.tickets)}</td>
                      <td className="text-right tabular-nums py-2 px-3">{formatSoles(it.ticket_promedio)}</td>
                      <td className="text-right tabular-nums py-2 px-3">{formatNum(it.clientes_unicos)}</td>
                      <td className={`text-right tabular-nums py-2 px-3 font-medium ${it.var_pct == null ? 'text-muted-foreground' : it.var_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {it.var_pct == null ? '—' : formatPct(it.var_pct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-2 text-[11px] text-muted-foreground border-t flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-primary/70 rounded-sm inline-block" /> Share individual
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-0.5 h-3 bg-amber-500 inline-block" /> Línea acumulada
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 bg-primary/5 border border-primary/20 rounded-sm inline-block" /> Concentra el 80% del negocio
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
