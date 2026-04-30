import { useEffect, useState, useCallback } from 'react';
import { api, formatSoles, formatPct } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Loader2, TrendingUp } from 'lucide-react';
import { toast } from 'sonner';
import { useFilters } from '../context/FiltersContext';

export default function Tendencias() {
  // Filtros vienen del FiltersContext (compartidos con Dashboard, Tiendas, etc.)
  const { filters } = useFilters();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      // Tendencias siempre usa vista YTD para comparar same-day multi-año
      const params = { vista: 'ytd', anios_compara: '2025,2024,2023' };
      if (filters.tiendas.length) params.tienda = filters.tiendas.join(',');
      if (filters.marcas.length) params.marca_id = filters.marcas.join(',');
      if (filters.tipos.length) params.tipo_id = filters.tipos.join(',');
      const res = await api.get('/dashboard', { params });
      setData(res.data);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [filters.tiendas, filters.marcas, filters.tipos]);

  useEffect(() => { cargar(); }, [cargar]);

  if (loading && !data) {
    return (
      <div className="p-6 space-y-5">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-40 w-full" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (!data) return null;

  const actual = { anio: new Date(data.periodo_actual.hasta).getFullYear(), kpis: data.kpis };
  const comparativos = Object.entries(data.comparativos || {})
    .map(([anio, c]) => ({ anio: Number(anio), kpis: c.kpis }))
    .sort((a, b) => a.anio - b.anio);
  const series = [...comparativos, actual];

  const maxVentas = Math.max(...series.map(s => s.kpis.ventas), 1);
  const maxTickets = Math.max(...series.map(s => s.kpis.tickets), 1);
  const maxUnidades = Math.max(...series.map(s => s.kpis.unidades), 1);

  const Bar = ({ value, max, label, color = 'bg-primary' }) => (
    <div className="flex items-center gap-3">
      <div className="w-16 text-sm font-semibold tabular-nums">{label}</div>
      <div className="flex-1 h-7 bg-muted rounded overflow-hidden">
        <div className={`h-full ${color} transition-all flex items-center justify-end px-2 text-xs text-white font-medium`}
             style={{ width: `${(value / max) * 100}%` }}>
          {(value / max) * 100 > 25 && formatSoles(value)}
        </div>
      </div>
      <div className="w-32 text-right text-xs text-muted-foreground tabular-nums">{formatSoles(value)}</div>
    </div>
  );

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-primary" /> Tendencias YTD multi-año
          </h1>
          <p className="text-sm text-muted-foreground">Same-day YTD al {data.periodo_actual.hasta}</p>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Ventas por año (YTD same-day)</CardTitle></CardHeader>
        <CardContent className="space-y-2.5">
          {series.map(s => (
            <Bar key={s.anio} label={s.anio} value={s.kpis.ventas} max={maxVentas}
              color={s.anio === actual.anio ? 'bg-primary' : 'bg-slate-400 dark:bg-slate-600'} />
          ))}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Tickets</CardTitle></CardHeader>
          <CardContent className="space-y-2.5">
            {series.map(s => (
              <div key={s.anio} className="flex items-center gap-3">
                <div className="w-16 text-sm font-semibold tabular-nums">{s.anio}</div>
                <div className="flex-1 h-6 bg-muted rounded overflow-hidden">
                  <div className={`h-full ${s.anio === actual.anio ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-600'}`}
                       style={{ width: `${(s.kpis.tickets / maxTickets) * 100}%` }} />
                </div>
                <div className="w-20 text-right text-xs tabular-nums text-muted-foreground">{s.kpis.tickets.toLocaleString('es-PE')}</div>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Unidades</CardTitle></CardHeader>
          <CardContent className="space-y-2.5">
            {series.map(s => (
              <div key={s.anio} className="flex items-center gap-3">
                <div className="w-16 text-sm font-semibold tabular-nums">{s.anio}</div>
                <div className="flex-1 h-6 bg-muted rounded overflow-hidden">
                  <div className={`h-full ${s.anio === actual.anio ? 'bg-indigo-500' : 'bg-slate-400 dark:bg-slate-600'}`}
                       style={{ width: `${(s.kpis.unidades / maxUnidades) * 100}%` }} />
                </div>
                <div className="w-20 text-right text-xs tabular-nums text-muted-foreground">{Math.round(s.kpis.unidades).toLocaleString('es-PE')}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Variaciones vs actual */}
      <Card>
        <CardHeader><CardTitle className="text-base">Variaciones vs {actual.anio}</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries(data.variaciones || {}).map(([anio, v]) => (
            <div key={anio} className="p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground">vs {anio}</div>
              <div className="grid grid-cols-2 gap-2 mt-2 text-sm">
                <div>
                  <div className="text-xs text-muted-foreground">Ventas</div>
                  <div className={`font-semibold ${v.ventas_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatPct(v.ventas_pct)}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Tickets</div>
                  <div className={`font-semibold ${v.tickets_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>{formatPct(v.tickets_pct)}</div>
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
