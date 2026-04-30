import { useEffect, useState, useCallback } from 'react';
import { api, formatSoles, formatNum, formatPct } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Loader2, MapPin, Info } from 'lucide-react';
import { toast } from 'sonner';
import { useFilters } from '../context/FiltersContext';

export default function Departamentos() {
  const { filters } = useFilters();
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const vista = filters.periodo === '12m' ? 'ytd' : filters.periodo;
      const params = { vista, anio_compara: 2025 };
      if (filters.tiendas.length) params.tienda = filters.tiendas.join(',');
      const res = await api.get('/departamentos/ventas', { params });
      setItems(res.data.items || []);
      setTotal(res.data.total_ventas || 0);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [filters.periodo, filters.tiendas]);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading) return (
    <div className="p-6 space-y-5">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-96 w-full" />
    </div>
  );

  const maxV = Math.max(...items.map(i => i.ventas), 1);

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <MapPin className="h-6 w-6 text-primary" /> Departamentos
        </h1>
        <p className="text-sm text-muted-foreground">Ventas YTD 2026 por departamento del cliente — Total: <span className="font-semibold text-foreground">{formatSoles(total)}</span></p>
      </div>

      <Card className="border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-900">
        <CardContent className="p-3 flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>Solo se incluyen ventas a clientes con departamento registrado en Odoo. Tickets anónimos se agrupan en "Sin definir".</span>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[calc(100vh-300px)]">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
              <tr>
                <th className="text-left py-2 px-4">Departamento</th>
                <th className="text-left py-2 px-4 w-[30%]">Distribución</th>
                <th className="text-right py-2 px-4">Ventas</th>
                <th className="text-right py-2 px-4">Share</th>
                <th className="text-right py-2 px-4">Tickets</th>
                <th className="text-right py-2 px-4">Clientes</th>
                <th className="text-right py-2 px-4">vs 2025</th>
              </tr>
            </thead>
            <tbody>
              {items.map(d => (
                <tr key={d.departamento} className="border-b hover:bg-muted/20">
                  <td className="py-2 px-4 font-medium">{d.departamento}</td>
                  <td className="py-2 px-4">
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${(d.ventas / maxV) * 100}%` }} />
                    </div>
                  </td>
                  <td className="text-right tabular-nums py-2 px-4 font-medium">{formatSoles(d.ventas)}</td>
                  <td className="text-right tabular-nums py-2 px-4">{d.share_pct}%</td>
                  <td className="text-right tabular-nums py-2 px-4">{formatNum(d.tickets)}</td>
                  <td className="text-right tabular-nums py-2 px-4">{formatNum(d.clientes_unicos)}</td>
                  <td className={`text-right tabular-nums py-2 px-4 font-medium ${d.var_pct == null ? 'text-muted-foreground' : d.var_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {d.var_pct == null ? '—' : formatPct(d.var_pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
