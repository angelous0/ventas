import { useState, useEffect, useCallback } from 'react';
import { useFilters } from '../context/FilterContext';
import { api, formatCurrency, formatCurrencyFull, formatNumber, formatPercent, calcChange, COLORS, MONTHS } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { Skeleton } from '../components/ui/skeleton';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { Download, TrendingUp, TrendingDown } from 'lucide-react';

const ChartTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-background border border-border shadow-sm rounded-sm p-3 text-xs">
      <p className="font-medium text-foreground mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-muted-foreground">
          <span style={{ color: p.color }}>{p.name}:</span> {formatCurrency(p.value)}
        </p>
      ))}
    </div>
  );
};

export default function SalesAnalysis() {
  const { options, getFilterParams } = useFilters();
  const [yearData, setYearData] = useState([]);
  const [monthlyData, setMonthlyData] = useState([]);
  const [selectedYears, setSelectedYears] = useState([]);
  const [loading, setLoading] = useState(true);

  const currentYear = new Date().getFullYear();

  // Initialize selected years
  useEffect(() => {
    if (options.years.length > 0 && selectedYears.length === 0) {
      const yrs = options.years.filter(y => y >= currentYear - 1).sort();
      setSelectedYears(yrs.length > 0 ? yrs : options.years.slice(0, 3));
    }
  }, [options.years, currentYear, selectedYears.length]);

  const toggleYear = useCallback((yr) => {
    setSelectedYears(prev =>
      prev.includes(yr) ? prev.filter(y => y !== yr) : [...prev, yr].sort()
    );
  }, []);

  useEffect(() => {
    if (selectedYears.length === 0) return;
    const fp = getFilterParams();
    setLoading(true);
    Promise.all([
      api.getSalesByYear(fp),
      api.getYearMonthly({ ...fp, years: selectedYears.join(',') }),
    ]).then(([byYear, monthly]) => {
      setYearData(byYear);
      // Pivot monthly data
      const pivoted = {};
      monthly.forEach(row => {
        if (!pivoted[row.month]) {
          pivoted[row.month] = { month: row.month, month_name: MONTHS[row.month - 1] };
        }
        pivoted[row.month][`sales_${row.year}`] = row.total_sales;
        pivoted[row.month][`orders_${row.year}`] = row.order_count;
        pivoted[row.month][`units_${row.year}`] = row.units_sold;
      });
      setMonthlyData(Object.values(pivoted).sort((a, b) => a.month - b.month));
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [selectedYears, getFilterParams]);

  const handleExport = () => {
    const fp = getFilterParams();
    api.exportExcel({ report: 'sales-by-year', ...fp });
  };

  if (loading && yearData.length === 0) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64 rounded-sm" />
        <Skeleton className="h-80 rounded-sm" />
        <Skeleton className="h-60 rounded-sm" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="sales-analysis-page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight font-heading leading-none">Analisis de Ventas</h1>
          <p className="text-sm text-muted-foreground mt-1">Comparacion interanual y tendencias</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-sm text-xs h-8" onClick={handleExport} data-testid="export-year-btn">
          <Download size={14} className="mr-1.5" /> Excel
        </Button>
      </div>

      {/* Year selector */}
      <div className="flex flex-wrap gap-2" data-testid="year-selector">
        {options.years.map(yr => (
          <Badge
            key={yr}
            variant={selectedYears.includes(yr) ? "default" : "outline"}
            className="cursor-pointer rounded-sm text-xs px-3 py-1 select-none"
            onClick={() => toggleYear(yr)}
            data-testid={`year-badge-${yr}`}
          >
            {yr}
          </Badge>
        ))}
      </div>

      {/* Monthly comparison chart */}
      <Card className="chart-card rounded-sm" data-testid="monthly-comparison-chart">
        <CardHeader className="pb-2 px-6 pt-5">
          <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
            Comparacion Mensual de Ventas
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <div className="h-[360px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={monthlyData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="month_name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: '11px' }} />
                {selectedYears.map((yr, i) => (
                  <Line
                    key={yr}
                    type="monotone"
                    dataKey={`sales_${yr}`}
                    stroke={COLORS[i % COLORS.length]}
                    strokeWidth={2}
                    dot={{ r: 3, fill: COLORS[i % COLORS.length] }}
                    name={`${yr}`}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Year summary table */}
      <Card className="rounded-sm" data-testid="year-summary-table">
        <CardHeader className="pb-2 px-6 pt-5">
          <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
            Resumen por Ano
          </CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-4">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="year-table">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ano</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ventas</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ordenes</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Unidades</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ticket</th>
                  <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Cambio</th>
                </tr>
              </thead>
              <tbody>
                {yearData.map((row, i) => {
                  const prev = i > 0 ? yearData[i - 1] : null;
                  const change = prev ? calcChange(row.total_sales, prev.total_sales) : null;
                  return (
                    <tr key={row.year} className="data-row border-b border-border/40" data-testid={`year-row-${row.year}`}>
                      <td className="py-2.5 font-heading font-bold">{row.year}</td>
                      <td className="py-2.5 text-right font-medium">{formatCurrencyFull(row.total_sales)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.order_count)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.units_sold)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatCurrency(row.avg_ticket)}</td>
                      <td className="py-2.5 text-right">
                        {change != null ? (
                          <span className={`inline-flex items-center gap-1 text-xs font-medium ${change > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>
                            {change > 0 ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                            {formatPercent(change)}
                          </span>
                        ) : <span className="text-xs text-muted-foreground">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Monthly comparison bar chart */}
      {selectedYears.length >= 2 && (
        <Card className="chart-card rounded-sm" data-testid="monthly-bar-comparison">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Ordenes por Mes (Comparacion)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={monthlyData} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                  <XAxis dataKey="month_name" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                  <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="bg-background border border-border shadow-sm rounded-sm p-3 text-xs">
                        <p className="font-medium text-foreground mb-1">{label}</p>
                        {payload.map((p, i) => (
                          <p key={i} className="text-muted-foreground">
                            <span style={{ color: p.color }}>{p.name}:</span> {formatNumber(p.value)} ordenes
                          </p>
                        ))}
                      </div>
                    );
                  }} />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  {selectedYears.map((yr, i) => (
                    <Bar key={yr} dataKey={`orders_${yr}`} fill={COLORS[i % COLORS.length]} radius={0} name={`${yr}`} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
