import { useState, useEffect } from 'react';
import { useFilters } from '../context/FilterContext';
import { api, formatCurrency, formatNumber, calcChange, COLORS, MONTHS } from '../lib/api';
import { KpiCard } from '../components/KpiCard';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { DollarSign, ShoppingCart, Tag, Package } from 'lucide-react';

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border border-border shadow-sm rounded-sm p-3 text-xs">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-muted-foreground">
          <span style={{ color: p.color }}>{p.name}:</span>{' '}
          {typeof p.value === 'number' ? formatCurrency(p.value) : p.value}
        </p>
      ))}
    </div>
  );
};

export default function Dashboard() {
  const { getFilterParams } = useFilters();
  const [kpis, setKpis] = useState(null);
  const [prevKpis, setPrevKpis] = useState(null);
  const [trend, setTrend] = useState([]);
  const [marcas, setMarcas] = useState([]);
  const [stores, setStores] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);

  const currentYear = new Date().getFullYear();
  const prevYear = currentYear - 1;

  useEffect(() => {
    const fp = getFilterParams();
    setLoading(true);
    // Compare same period: YTD this year vs same period last year
    const now = new Date();
    const monthDay = `-${String(now.getMonth() + 2).padStart(2, '0')}-01`; // Start of next month
    const currentEnd = `${currentYear}${monthDay}`;
    const prevEnd = `${prevYear}${monthDay}`;
    Promise.all([
      api.getKpis({ ...fp, start_date: `${currentYear}-01-01`, end_date: currentEnd }),
      api.getKpis({ ...fp, start_date: `${prevYear}-01-01`, end_date: prevEnd }),
      api.getSalesTrend({ ...fp, year: currentYear }),
      api.getSalesByMarca({ ...fp, year: currentYear }),
      api.getSalesByStore({ ...fp, year: currentYear }),
      api.getTopClients({ ...fp, year: currentYear, limit: 5 }),
    ]).then(([kD, pD, tD, mD, sD, cD]) => {
      setKpis(kD);
      setPrevKpis(pD);
      setTrend(tD.map(t => ({ ...t, month_name: MONTHS[t.month - 1] })));
      setMarcas(mD);
      setStores(sD.slice(0, 8));
      setClients(cD);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [getFilterParams, currentYear, prevYear]);

  if (loading) {
    return (
      <div className="space-y-4" data-testid="dashboard-loading">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-sm" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Skeleton className="h-72 rounded-sm lg:col-span-2" />
          <Skeleton className="h-72 rounded-sm" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="dashboard-page">
      <div>
        <h1 className="text-2xl font-black tracking-tight font-heading leading-none">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">Resumen de ventas {currentYear}</p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4" data-testid="kpi-row">
        <KpiCard label="Total Ventas" value={formatCurrency(kpis?.total_sales)} change={calcChange(kpis?.total_sales, prevKpis?.total_sales)} icon={DollarSign} testId="kpi-total-ventas" />
        <KpiCard label="Ordenes" value={formatNumber(kpis?.order_count)} change={calcChange(kpis?.order_count, prevKpis?.order_count)} icon={ShoppingCart} testId="kpi-ordenes" />
        <KpiCard label="Ticket Promedio" value={formatCurrency(kpis?.avg_ticket)} change={calcChange(kpis?.avg_ticket, prevKpis?.avg_ticket)} icon={Tag} testId="kpi-ticket" />
        <KpiCard label="Unidades" value={formatNumber(kpis?.units_sold)} change={calcChange(kpis?.units_sold, prevKpis?.units_sold)} icon={Package} testId="kpi-unidades" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="chart-card rounded-sm lg:col-span-2" data-testid="trend-chart">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Tendencia Mensual {currentYear}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="h-[280px]" style={{ minHeight: '280px' }}>
              <ResponsiveContainer width="100%" height="100%" minWidth={0} minWidth={0}>
                <BarChart data={trend} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="month_name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="total_sales" fill={COLORS[0]} radius={0} name="Ventas" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="chart-card rounded-sm" data-testid="marca-chart">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Ventas por Marca
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-4">
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={marcas} layout="vertical" margin={{ top: 5, right: 10, left: 5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                  <YAxis dataKey="marca" type="category" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={90} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="total_sales" radius={0} name="Ventas">
                    {marcas.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bottom row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="chart-card rounded-sm" data-testid="store-chart">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Top Tiendas
            </CardTitle>
          </CardHeader>
          <CardContent className="px-2 pb-4">
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={stores} layout="vertical" margin={{ top: 5, right: 10, left: 5, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                  <YAxis dataKey="store_code" type="category" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={70} />
                  <Tooltip content={<ChartTooltip />} />
                  <Bar dataKey="total_sales" fill={COLORS[2]} radius={0} name="Ventas" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="chart-card rounded-sm" data-testid="clients-table">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Top Clientes
            </CardTitle>
          </CardHeader>
          <CardContent className="px-6 pb-4">
            <div className="space-y-0">
              {clients.map((c, i) => (
                <div
                  key={c.client_id}
                  className="data-row flex items-center justify-between py-3 border-b border-border/40 last:border-0"
                  data-testid={`client-row-${i}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-xs font-bold text-muted-foreground/60 w-4 shrink-0">{i + 1}</span>
                    <span className="text-sm font-medium truncate">{c.client_name}</span>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <p className="text-sm font-semibold font-heading">{formatCurrency(c.total_sales)}</p>
                    <p className="text-[10px] text-muted-foreground">{formatNumber(c.order_count)} ordenes</p>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
