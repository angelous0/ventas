import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, API, formatSoles, formatNum, formatPct } from '../lib/api';
import { KPICard } from '../components/KPICard';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import {
  DollarSign, Package, Receipt, TrendingUp, Users, UserPlus, RefreshCw, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, Tooltip as RTooltip, XAxis } from 'recharts';
import { toast } from 'sonner';
import ExportarVentas from '../components/ExportarVentas';
import { useFilters } from '../context/FiltersContext';
import { EvolucionMensual } from '../components/EvolucionMensual';

/**
 * Dashboard ejecutivo:
 *  - Headline hero con ventas YTD grandes + sparkline 6 meses
 *  - KPIs secundarios en grid
 *  - Comparativos multi-año
 *  - Crecen / caen
 *
 * Lee filtros del FiltersContext (periodo + tiendas + marcas + tipos).
 * Las llamadas al backend corren en Promise.all para minimizar latencia.
 */
export default function Dashboard() {
  const { filters } = useFilters();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [crecenCaen, setCrecenCaen] = useState(null);
  const [sparkline, setSparkline] = useState([]);
  // Series mensuales del año actual para alimentar mini-sparklines en KPICards
  const [monthlySeries, setMonthlySeries] = useState(null);

  // Map filters → params del endpoint /dashboard
  const apiParams = useMemo(() => {
    const p = { vista: filters.periodo === '12m' ? 'ytd' : filters.periodo };
    if (filters.periodo === 'ytd') p.anios_compara = '2025,2024';
    if (filters.periodo === 'custom') {
      if (filters.desde) p.desde = filters.desde;
      if (filters.hasta) p.hasta = filters.hasta;
    }
    if (filters.tiendas.length) p.tienda = filters.tiendas.join(',');
    if (filters.marcas.length) p.marca_id = filters.marcas.join(',');
    if (filters.tipos.length) p.tipo_id = filters.tipos.join(',');
    return p;
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    const cargar = async () => {
      setLoading(true);
      try {
        // 4 fetches en paralelo
        const dashP = api.get('/dashboard', { params: apiParams });

        const ccParams = { anio_compara: 2025, top: 5, min_unidades: 5 };
        if (filters.tiendas.length) ccParams.tienda = filters.tiendas.join(',');
        const ccP = filters.periodo === 'ytd'
          ? api.get('/productos/crecen-caen', { params: ccParams }).catch(() => ({ data: null }))
          : Promise.resolve({ data: null });

        // Evolución mensual (3 años) — para sparkline hero + sparklines KPIs
        const hoyAnio = new Date().getFullYear();
        const evoParams = { anios: `${hoyAnio - 2},${hoyAnio - 1},${hoyAnio}` };
        if (filters.tiendas.length) evoParams.tienda = filters.tiendas.join(',');
        if (filters.marcas.length) evoParams.marca_id = filters.marcas.join(',');
        if (filters.tipos.length) evoParams.tipo_id = filters.tipos.join(',');
        const evoP = api.get('/dashboard/evolucion-mensual', { params: evoParams })
          .catch(() => ({ data: null }));

        const [dashR, ccR, evoR] = await Promise.all([dashP, ccP, evoP]);

        if (cancelled) return;
        setData(dashR.data);
        setCrecenCaen(ccR.data);

        // Sparkline hero: últimos 6 meses (rebanando del año actual + previo)
        const evo = evoR.data;
        if (evo?.series) {
          const anios = evo.anios || [];
          const flat = [];
          anios.forEach(a => {
            (evo.series[String(a)] || []).forEach(m => {
              flat.push({ mes: `${a}-${String(m.mes).padStart(2, '0')}`, ventas: m.ventas, unidades: m.unidades, tickets: m.tickets });
            });
          });
          // Filtrar hasta mes actual del año actual y tomar últimos 6
          const hoyMes = new Date().getMonth() + 1;
          const cutoff = `${hoyAnio}-${String(hoyMes).padStart(2, '0')}`;
          const validos = flat.filter(d => d.mes <= cutoff);
          setSparkline(validos.slice(-6));
          setMonthlySeries(evo);
        } else {
          setSparkline([]);
          setMonthlySeries(null);
        }
      } catch (e) {
        if (!cancelled) toast.error('Error al cargar dashboard: ' + (e.response?.data?.detail || e.message));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    cargar();
    return () => { cancelled = true; };
  }, [apiParams, filters.periodo, filters.tiendas]);

  // Skeleton inicial mientras NO hay data — mantiene el layout
  if (loading && !data) return <DashboardSkeleton />;
  if (!data) return null;

  const kpis = data.kpis;
  const v2025 = data.variaciones?.['2025'] || {};
  const periodoActual = data.periodo_actual.hasta.slice(0, 4);

  // Sparklines (últimos 6 meses) por métrica para los KPI cards
  const sparkPorMetrica = (metrica) => {
    if (!monthlySeries?.series) return null;
    const anios = monthlySeries.anios || [];
    const flat = [];
    anios.forEach(a => {
      (monthlySeries.series[String(a)] || []).forEach(m => {
        flat.push({ mes: `${a}-${String(m.mes).padStart(2, '0')}`, valor: m[metrica] || 0 });
      });
    });
    const hoyAnio = new Date().getFullYear();
    const hoyMes = new Date().getMonth() + 1;
    const cutoff = `${hoyAnio}-${String(hoyMes).padStart(2, '0')}`;
    return flat.filter(d => d.mes <= cutoff).slice(-6).map(d => d.valor);
  };
  const sparkVentas = sparkPorMetrica('ventas');
  const sparkUnidades = sparkPorMetrica('unidades');
  const sparkTickets = sparkPorMetrica('tickets');
  // Ticket promedio = ventas / tickets por mes
  const sparkTicketProm = (() => {
    if (!sparkVentas || !sparkTickets) return null;
    return sparkVentas.map((v, i) => sparkTickets[i] > 0 ? v / sparkTickets[i] : 0);
  })();

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard de Ventas</h1>
          <p className="text-sm text-muted-foreground">
            {data.periodo_actual.desde} → {data.periodo_actual.hasta}
            {filters.tiendas.length > 0 && <span className="ml-2">· {filters.tiendas.length} tienda{filters.tiendas.length === 1 ? '' : 's'}</span>}
          </p>
        </div>
        <ExportarVentas tienda={filters.tiendas.length === 1 ? filters.tiendas[0] : null} />
      </div>

      {/* HERO HEADLINE */}
      <HeroVentas
        ventas={kpis.ventas}
        variacion={v2025.ventas_pct}
        sparkline={sparkline}
        anioActual={periodoActual}
      />

      {/* Evolución mensual: 3 años en 12 meses */}
      <EvolucionMensual />

      {/* KPIs grid 4 col — con mini-sparklines de últimos 6 meses */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPICard label="Unidades"     value={formatNum(kpis.unidades)}        subtitle="netas"   variation={v2025.unidades_pct}        icon={Package}    spark={sparkUnidades}    sparkFmt={(v) => `${formatNum(v)} und`} />
        <KPICard label="Tickets"      value={formatNum(kpis.tickets)}         subtitle="órdenes" variation={v2025.tickets_pct}         icon={Receipt}    spark={sparkTickets}     sparkFmt={(v) => `${formatNum(v)} tickets`} />
        <KPICard label="Ticket prom"  value={formatSoles(kpis.ticket_promedio)}                   variation={v2025.ticket_promedio_pct} icon={TrendingUp} spark={sparkTicketProm}  sparkFmt={(v) => formatSoles(v)} />
        <KPICard label="Clientes"     value={formatNum(kpis.clientes_unicos)} subtitle="únicos"  variation={v2025.clientes_unicos_pct} icon={Users}      spark={null} />
      </div>

      {/* KPIs grid extra */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <KPICard label="Clientes nuevos (30d)" value={formatNum(kpis.clientes_nuevos_30d)}
          subtitle="primera compra reciente" icon={UserPlus} />
        <KPICard label="Devoluciones" value={formatSoles(kpis.devoluciones_netas)}
          subtitle={`${kpis.devoluciones_pct}% de ventas netas`} icon={RefreshCw} />
      </div>

      {/* Comparativos multi-año */}
      {data.comparativos && Object.keys(data.comparativos).length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Comparativos same-day</CardTitle></CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-2 px-3">Año</th>
                    <th className="text-right py-2 px-3">Ventas</th>
                    <th className="text-right py-2 px-3">Unidades</th>
                    <th className="text-right py-2 px-3">Tickets</th>
                    <th className="text-right py-2 px-3">Ticket Prom</th>
                    <th className="text-right py-2 px-3">Clientes</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b font-medium">
                    <td className="py-2 px-3 text-primary">{periodoActual} (actual)</td>
                    <td className="text-right tabular-nums">{formatSoles(kpis.ventas)}</td>
                    <td className="text-right tabular-nums">{formatNum(kpis.unidades)}</td>
                    <td className="text-right tabular-nums">{formatNum(kpis.tickets)}</td>
                    <td className="text-right tabular-nums">{formatSoles(kpis.ticket_promedio)}</td>
                    <td className="text-right tabular-nums">{formatNum(kpis.clientes_unicos)}</td>
                  </tr>
                  {Object.entries(data.comparativos).map(([anio, c]) => {
                    const v = data.variaciones[anio] || {};
                    const cell = (val) => {
                      if (val == null) return '';
                      const col = val > 0 ? 'text-emerald-600' : val < 0 ? 'text-red-600' : 'text-muted-foreground';
                      return <span className={`ml-2 text-xs ${col}`}>({formatPct(val)})</span>;
                    };
                    return (
                      <tr key={anio} className="border-b">
                        <td className="py-2 px-3 text-muted-foreground">{anio}</td>
                        <td className="text-right tabular-nums">{formatSoles(c.kpis.ventas)}{cell(v.ventas_pct)}</td>
                        <td className="text-right tabular-nums">{formatNum(c.kpis.unidades)}{cell(v.unidades_pct)}</td>
                        <td className="text-right tabular-nums">{formatNum(c.kpis.tickets)}{cell(v.tickets_pct)}</td>
                        <td className="text-right tabular-nums">{formatSoles(c.kpis.ticket_promedio)}{cell(v.ticket_promedio_pct)}</td>
                        <td className="text-right tabular-nums">{formatNum(c.kpis.clientes_unicos)}{cell(v.clientes_unicos_pct)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top crecen / caen — con impacto absoluto en S/. */}
      {crecenCaen && (crecenCaen.crecen?.length > 0 || crecenCaen.caen?.length > 0) && (
        <CrecenCaenSection crecenCaen={crecenCaen} />
      )}
    </div>
  );
}

// ============== HERO ==============

// Formato mes 'YYYY-MM' → 'Ene' / 'Ene 26'
const MES_NOMBRES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function fmtMesShort(s) {
  if (!s || typeof s !== 'string') return s;
  const [, m] = s.split('-');
  const n = parseInt(m, 10);
  return n >= 1 && n <= 12 ? MES_NOMBRES[n - 1] : s;
}
function fmtMesLong(s) {
  if (!s || typeof s !== 'string') return s;
  const [y, m] = s.split('-');
  const n = parseInt(m, 10);
  const yy = (y || '').slice(-2);
  return n >= 1 && n <= 12 ? `${MES_NOMBRES[n - 1]} ${yy}` : s;
}

function HeroVentas({ ventas, variacion, sparkline, anioActual }) {
  const tieneVariacion = variacion != null && !isNaN(variacion);
  const positivo = tieneVariacion && variacion > 0;
  const negativo = tieneVariacion && variacion < 0;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-6 md:p-8 grid grid-cols-1 lg:grid-cols-5 gap-6 items-center">
        <div className="lg:col-span-2 space-y-2">
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            Ventas {anioActual}
          </div>
          <div className="text-4xl md:text-5xl font-bold tabular-nums tracking-tight">
            {formatSoles(ventas)}
          </div>
          {tieneVariacion && (
            <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold ${
              positivo ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' :
              negativo ? 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300' :
                         'bg-muted text-muted-foreground'
            }`}>
              {positivo && <ArrowUpRight className="h-3.5 w-3.5" />}
              {negativo && <ArrowDownRight className="h-3.5 w-3.5" />}
              {formatPct(variacion)} vs año anterior
            </div>
          )}
        </div>
        <div className="lg:col-span-3 h-32">
          {sparkline.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={sparkline} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                <XAxis
                  dataKey="mes"
                  tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={fmtMesShort}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                />
                <RTooltip
                  contentStyle={{ fontSize: 11, padding: '6px 10px', borderRadius: 6 }}
                  formatter={(v) => [formatSoles(v), 'Ventas']}
                  labelFormatter={(l) => fmtMesLong(l)}
                />
                <Line type="monotone" dataKey="ventas" stroke="hsl(var(--primary))"
                      strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Sparkline no disponible
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ============== Listas crecen/caen con impacto en soles ==============

function CrecenCaenSection({ crecenCaen }) {
  const [orden, setOrden] = useState('impacto'); // 'impacto' (S/.) | 'pct' (%)

  // Enriquecer con delta absoluto y reordenar según toggle
  const enrich = (items, isPositivo) => {
    if (!items) return [];
    const enriched = items.map(it => ({
      ...it,
      delta: (it.ventas_actual || 0) - (it.ventas_anterior || 0),
    }));
    if (orden === 'impacto') {
      // Mayor magnitud absoluta primero (positivos: mayor delta+; negativos: mayor delta-)
      return enriched.sort((a, b) =>
        isPositivo ? b.delta - a.delta : a.delta - b.delta
      );
    }
    // Por % var: positivos desc, negativos asc
    return enriched.sort((a, b) =>
      isPositivo ? b.var_pct - a.var_pct : a.var_pct - b.var_pct
    );
  };

  const crecen = enrich(crecenCaen.crecen, true);
  const caen = enrich(crecenCaen.caen, false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Movimiento de productos</h2>
        <div className="flex gap-0.5 p-0.5 rounded border bg-muted/30 text-xs">
          <button onClick={() => setOrden('impacto')}
            className={`px-2 py-0.5 rounded ${orden === 'impacto' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
            Por impacto S/.
          </button>
          <button onClick={() => setOrden('pct')}
            className={`px-2 py-0.5 rounded ${orden === 'pct' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-muted'}`}>
            Por %
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ListaCrecenCaen titulo="Top 5 que crecen" items={crecen} positivo />
        <ListaCrecenCaen titulo="Top 5 que caen"   items={caen}   positivo={false} />
      </div>
    </div>
  );
}

function ListaCrecenCaen({ titulo, items, positivo }) {
  const navigate = useNavigate();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {positivo ? <ArrowUpRight className="h-4 w-4 text-emerald-600" /> : <ArrowDownRight className="h-4 w-4 text-red-600" />}
          {titulo}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">Sin productos</p>
        ) : items.map(it => (
          <button key={it.product_tmpl_id}
            onClick={() => navigate(`/productos/${it.product_tmpl_id}`)}
            className="w-full text-left flex items-center justify-between text-sm border-b pb-2 last:border-0 hover:bg-accent/30 -mx-2 px-2 py-1 rounded transition-colors group">
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate group-hover:text-primary">{it.nombre}</div>
              <div className="text-xs text-muted-foreground truncate">
                {it.marca || '—'} · {it.tipo || '—'} · {it.entalle || '—'} · {it.tela || '—'}
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                {formatSoles(it.ventas_anterior)} → {formatSoles(it.ventas_actual)}
              </div>
            </div>
            <div className="text-right shrink-0 ml-2">
              <div className={`text-sm font-bold tabular-nums ${positivo ? 'text-emerald-600' : 'text-red-600'}`}>
                {it.delta >= 0 ? '+' : ''}{formatSoles(it.delta)}
              </div>
              <div className={`text-xs ${positivo ? 'text-emerald-600' : 'text-red-600'}`}>{formatPct(it.var_pct)}</div>
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

// ============== Skeleton (mantiene layout) ==============

function DashboardSkeleton() {
  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      {/* Hero */}
      <Card>
        <CardContent className="p-8 grid grid-cols-1 lg:grid-cols-5 gap-6 items-center">
          <div className="lg:col-span-2 space-y-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-12 w-56" />
            <Skeleton className="h-6 w-32" />
          </div>
          <div className="lg:col-span-3 h-28">
            <Skeleton className="h-full w-full" />
          </div>
        </CardContent>
      </Card>
      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <Skeleton className="h-48" />
    </div>
  );
}
