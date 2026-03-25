import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { useFilters } from '../context/FilterContext';
import { api, formatCurrency, formatCurrencyFull, formatNumber, COLORS, MONTHS } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, Cell
} from 'recharts';
import { Download, MapPin, CalendarDays, DollarSign, Package } from 'lucide-react';

const ChartTooltip = ({ active, payload, label, metricMode }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border border-border shadow-sm rounded-sm p-3 text-xs">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-muted-foreground">
          <span style={{ color: p.color }}>{p.name}:</span>{' '}
          {metricMode === 'qty' ? formatNumber(p.value) : formatCurrency(p.value)}
        </p>
      ))}
    </div>
  );
};

const GRAN_OPTIONS = [
  { value: 'day', label: 'Dia' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
];

const METRIC_OPTIONS = [
  { value: 'sales', label: 'Dinero', icon: DollarSign },
  { value: 'qty', label: 'Cantidad', icon: Package },
];

function formatPeriodLabel(dateStr, granularity) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  if (granularity === 'day') {
    return `${d.getDate()}/${d.getMonth() + 1}`;
  }
  if (granularity === 'week') {
    const end = new Date(d);
    end.setDate(end.getDate() + 6);
    return `${d.getDate()}/${d.getMonth() + 1} - ${end.getDate()}/${end.getMonth() + 1}`;
  }
  return MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

export default function Stores() {
  const { options, getFilterParams } = useFilters();
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [timelineData, setTimelineData] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [selectedStores, setSelectedStores] = useState([]);
  const [granularity, setGranularity] = useState('month');
  const [metricMode, setMetricMode] = useState('sales');
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const currentYear = new Date().getFullYear();

  // Load store ranking
  useEffect(() => {
    const fp = getFilterParams();
    setLoading(true);
    api.getSalesByStore({ ...fp, year: currentYear })
      .then(data => {
        setStores(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [getFilterParams, currentYear]);

  // Auto-select first 2 stores when data loads
  useEffect(() => {
    if (stores.length > 0 && selectedStores.length === 0) {
      setSelectedStores(stores.slice(0, 2).map(s => s.store_code));
    }
  }, [stores, selectedStores.length]);

  const toggleStore = useCallback((code) => {
    setSelectedStores(prev =>
      prev.includes(code) ? prev.filter(s => s !== code) : [...prev, code]
    );
  }, []);

  // Load timeline data
  useEffect(() => {
    if (selectedStores.length === 0) {
      setTimelineData([]);
      return;
    }
    const fp = getFilterParams();
    setTimelineLoading(true);
    api.getStoreTimeline({
      ...fp,
      granularity,
      store: selectedStores.join(','),
      year: selectedYear,
    })
      .then(data => {
        setTimelineData(data);
        setTimelineLoading(false);
      })
      .catch(() => setTimelineLoading(false));
  }, [selectedStores, granularity, selectedYear, getFilterParams]);

  // Pivot timeline data for multi-store line chart
  const chartData = useMemo(() => {
    if (!timelineData.length) return [];
    const grouped = {};
    timelineData.forEach(row => {
      const key = row.period;
      if (!grouped[key]) {
        grouped[key] = { period: key, label: formatPeriodLabel(key, granularity) };
      }
      const store = row.store_code;
      grouped[key][`sales_${store}`] = row.total_sales;
      grouped[key][`qty_${store}`] = row.units_sold;
      grouped[key][`orders_${store}`] = row.order_count;
    });
    return Object.values(grouped).sort((a, b) => a.period.localeCompare(b.period));
  }, [timelineData, granularity]);

  const handleExport = () => {
    api.exportExcel({ report: 'sales-by-store', ...getFilterParams(), year: currentYear });
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48 rounded-sm" />
        <Skeleton className="h-80 rounded-sm" />
        <Skeleton className="h-60 rounded-sm" />
      </div>
    );
  }

  const totalSales = stores.reduce((s, st) => s + st.total_sales, 0);
  const dataKeyPrefix = metricMode === 'sales' ? 'sales' : 'qty';

  return (
    <div className="space-y-6" data-testid="stores-page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight font-heading leading-none">Tiendas</h1>
          <p className="text-sm text-muted-foreground mt-1">Rendimiento por punto de venta ({currentYear})</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-sm text-xs h-8" onClick={handleExport} data-testid="export-store-btn">
          <Download size={14} className="mr-1.5" /> Excel
        </Button>
      </div>

      {/* Bar chart - Ranking */}
      <Card className="chart-card rounded-sm" data-testid="store-bar-chart">
        <CardContent className="pt-6 px-4 pb-4">
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <BarChart data={stores} layout="vertical" margin={{ top: 5, right: 20, left: 5, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                <YAxis dataKey="store_code" type="category" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={80} />
                <Tooltip content={<ChartTooltip metricMode="sales" />} />
                <Bar dataKey="total_sales" radius={0} name="Ventas">
                  {stores.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Table - Ranking */}
      <Card className="rounded-sm" data-testid="store-table-card">
        <CardHeader className="pb-2 px-6 pt-5">
          <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
            Ranking de Tiendas
          </CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="store-table">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground w-8">#</th>
                  <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Tienda</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ventas</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ordenes</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Unidades</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ticket</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">% Total</th>
                </tr>
              </thead>
              <tbody>
                {stores.map((row, i) => (
                  <tr key={row.store_code} className="data-row border-b border-border/40" data-testid={`store-row-${i}`}>
                    <td className="py-2.5 text-muted-foreground text-xs font-bold">{i + 1}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <MapPin size={13} className="text-muted-foreground/50 shrink-0" />
                        <span className="font-medium">{row.store_code}</span>
                      </div>
                    </td>
                    <td className="py-2.5 text-right font-medium">{formatCurrencyFull(row.total_sales)}</td>
                    <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.order_count)}</td>
                    <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.units_sold)}</td>
                    <td className="py-2.5 text-right text-muted-foreground">{formatCurrency(row.avg_ticket)}</td>
                    <td className="py-2.5 text-right text-muted-foreground">
                      {totalSales > 0 ? `${((row.total_sales / totalSales) * 100).toFixed(1)}%` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ─── Temporal Tracking Section ─── */}
      <div className="pt-2">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays size={18} className="text-muted-foreground" />
          <h2 className="text-lg font-bold tracking-tight font-heading">Seguimiento Temporal</h2>
        </div>

        {/* Year selector */}
        <div className="flex flex-wrap gap-2 mb-3" data-testid="timeline-year-selector">
          {options.years.map(yr => (
            <Badge
              key={yr}
              variant={selectedYear === yr ? "default" : "outline"}
              className="cursor-pointer rounded-sm text-xs px-3 py-1 select-none transition-colors duration-150"
              onClick={() => setSelectedYear(yr)}
              data-testid={`timeline-year-${yr}`}
            >
              {yr}
            </Badge>
          ))}
        </div>

        {/* Store selector */}
        <div className="flex flex-wrap gap-1.5 mb-4" data-testid="timeline-store-selector">
          {stores.map((s, i) => (
            <Badge
              key={s.store_code}
              variant={selectedStores.includes(s.store_code) ? "default" : "outline"}
              className="cursor-pointer rounded-sm text-xs px-2.5 py-1 select-none transition-colors duration-150"
              style={selectedStores.includes(s.store_code) ? { backgroundColor: COLORS[i % COLORS.length], borderColor: COLORS[i % COLORS.length] } : {}}
              onClick={() => toggleStore(s.store_code)}
              data-testid={`timeline-store-badge-${s.store_code}`}
            >
              {s.store_code}
            </Badge>
          ))}
        </div>

        {/* Controls row */}
        <div className="flex items-center gap-4 mb-4 flex-wrap">
          {/* Granularity */}
          <div className="flex items-center gap-1 bg-muted rounded-sm p-0.5" data-testid="granularity-selector">
            {GRAN_OPTIONS.map(g => (
              <button
                key={g.value}
                onClick={() => setGranularity(g.value)}
                className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors duration-150 ${
                  granularity === g.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                data-testid={`gran-${g.value}`}
              >
                {g.label}
              </button>
            ))}
          </div>

          {/* Metric toggle */}
          <div className="flex items-center gap-1 bg-muted rounded-sm p-0.5" data-testid="metric-selector">
            {METRIC_OPTIONS.map(m => {
              const Icon = m.icon;
              return (
                <button
                  key={m.value}
                  onClick={() => setMetricMode(m.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-colors duration-150 flex items-center gap-1.5 ${
                    metricMode === m.value
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                  data-testid={`metric-${m.value}`}
                >
                  <Icon size={12} />
                  {m.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Timeline Chart */}
        {selectedStores.length > 0 && (
          <Card className="chart-card rounded-sm" data-testid="store-timeline-chart">
            <CardHeader className="pb-2 px-6 pt-5">
              <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
                {metricMode === 'sales' ? 'Ventas (S/)' : 'Unidades Vendidas'} — Por {GRAN_OPTIONS.find(g => g.value === granularity)?.label} ({selectedYear})
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {timelineLoading ? (
                <Skeleton className="h-[360px] rounded-sm" />
              ) : chartData.length === 0 ? (
                <div className="h-[360px] flex items-center justify-center text-sm text-muted-foreground">
                  Sin datos para los filtros seleccionados
                </div>
              ) : (
                <div style={{ width: '100%', height: 360 }}>
                  <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                    <LineChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                      <XAxis
                        dataKey="label"
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={false}
                        tickLine={false}
                        interval={granularity === 'day' ? Math.max(Math.floor(chartData.length / 15), 0) : 0}
                        angle={granularity === 'day' ? -45 : 0}
                        textAnchor={granularity === 'day' ? 'end' : 'middle'}
                        height={granularity === 'day' ? 60 : 30}
                      />
                      <YAxis
                        tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) =>
                          metricMode === 'sales'
                            ? (v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : `${(v/1000).toFixed(0)}K`)
                            : formatNumber(v)
                        }
                      />
                      <Tooltip content={<ChartTooltip metricMode={metricMode} />} />
                      <Legend wrapperStyle={{ fontSize: '11px' }} />
                      {selectedStores.map((store, i) => {
                        const storeIdx = stores.findIndex(s => s.store_code === store);
                        const colorIdx = storeIdx >= 0 ? storeIdx : i;
                        return (
                          <Line
                            key={store}
                            type="monotone"
                            dataKey={`${dataKeyPrefix}_${store}`}
                            stroke={COLORS[colorIdx % COLORS.length]}
                            strokeWidth={2.5}
                            dot={{ r: granularity === 'day' ? 0 : 4, fill: COLORS[colorIdx % COLORS.length], strokeWidth: 0 }}
                            activeDot={{ r: 6 }}
                            name={store}
                            connectNulls={false}
                          />
                        );
                      })}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Timeline Data Table */}
        {selectedStores.length > 0 && chartData.length > 0 && !timelineLoading && (
          <Card className="rounded-sm" data-testid="store-timeline-table-card">
            <CardHeader className="pb-2 px-6 pt-5">
              <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
                Detalle por {GRAN_OPTIONS.find(g => g.value === granularity)?.label} ({selectedYear})
              </CardTitle>
            </CardHeader>
            <CardContent className="px-6 pb-4">
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="store-timeline-table">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Periodo</th>
                      {selectedStores.map(store => (
                        <th key={store} className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground" colSpan={2}>
                          {store}
                        </th>
                      ))}
                    </tr>
                    <tr className="border-b border-border/60">
                      <th></th>
                      {selectedStores.map(store => (
                        <Fragment key={store}>
                          <th className="text-right py-1.5 text-[9px] tracking-[0.1em] uppercase text-muted-foreground/70 font-medium">Ventas</th>
                          <th className="text-right py-1.5 text-[9px] tracking-[0.1em] uppercase text-muted-foreground/70 font-medium">Uds</th>
                        </Fragment>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {chartData.slice(-30).map((row) => (
                      <tr key={row.period} className="data-row border-b border-border/40" data-testid={`timeline-row-${row.period}`}>
                        <td className="py-2 font-medium text-xs">{row.label}</td>
                        {selectedStores.map(store => (
                          <Fragment key={store}>
                            <td className="py-2 text-right text-xs">{formatCurrency(row[`sales_${store}`] || 0)}</td>
                            <td className="py-2 text-right text-xs text-muted-foreground">{formatNumber(row[`qty_${store}`] || 0)}</td>
                          </Fragment>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        )}

        {selectedStores.length === 0 && (
          <Card className="rounded-sm" data-testid="no-store-selected">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Selecciona al menos una tienda para ver el seguimiento temporal
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
