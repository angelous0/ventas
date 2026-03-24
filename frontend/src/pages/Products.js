import { useState, useEffect } from 'react';
import { useFilters } from '../context/FilterContext';
import { api, formatCurrency, formatCurrencyFull, formatNumber, COLORS, MONTHS } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Skeleton } from '../components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, Legend,
  LineChart, Line
} from 'recharts';
import { Download } from 'lucide-react';

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

export default function Products() {
  const { getFilterParams } = useFilters();
  const [marcas, setMarcas] = useState([]);
  const [tipos, setTipos] = useState([]);
  const [marcaTrend, setMarcaTrend] = useState([]);
  const [loading, setLoading] = useState(true);

  const currentYear = new Date().getFullYear();

  useEffect(() => {
    const fp = getFilterParams();
    setLoading(true);
    Promise.all([
      api.getSalesByMarca({ ...fp, year: currentYear }),
      api.getSalesByTipo({ ...fp, year: currentYear }),
      api.getMarcaTrend(fp),
    ]).then(([mD, tD, mtD]) => {
      setMarcas(mD);
      setTipos(tD);
      // Pivot marca trend for chart
      const allMarcas = [...new Set(mtD.map(r => r.marca))];
      const allYears = [...new Set(mtD.map(r => r.year))].sort();
      const pivoted = allYears.map(yr => {
        const row = { year: yr };
        allMarcas.forEach(m => {
          const found = mtD.find(r => r.year === yr && r.marca === m);
          row[m] = found ? found.total_sales : 0;
        });
        return row;
      });
      setMarcaTrend(pivoted);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [getFilterParams, currentYear]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48 rounded-sm" />
        <Skeleton className="h-80 rounded-sm" />
        <Skeleton className="h-60 rounded-sm" />
      </div>
    );
  }

  const topMarcas = marcas.slice(0, 5).map(m => m.marca);

  return (
    <div className="space-y-6" data-testid="products-page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight font-heading leading-none">Productos</h1>
          <p className="text-sm text-muted-foreground mt-1">Analisis por marca y tipo de producto ({currentYear})</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" className="rounded-sm text-xs h-8" onClick={() => api.exportExcel({ report: 'sales-by-marca', ...getFilterParams(), year: currentYear })} data-testid="export-marca-btn">
            <Download size={14} className="mr-1.5" /> Marcas
          </Button>
          <Button variant="outline" size="sm" className="rounded-sm text-xs h-8" onClick={() => api.exportExcel({ report: 'sales-by-tipo', ...getFilterParams(), year: currentYear })} data-testid="export-tipo-btn">
            <Download size={14} className="mr-1.5" /> Tipos
          </Button>
        </div>
      </div>

      <Tabs defaultValue="marcas" data-testid="product-tabs">
        <TabsList className="rounded-sm h-8">
          <TabsTrigger value="marcas" className="text-xs rounded-sm" data-testid="tab-marcas">Marcas</TabsTrigger>
          <TabsTrigger value="tipos" className="text-xs rounded-sm" data-testid="tab-tipos">Tipos</TabsTrigger>
          <TabsTrigger value="tendencia" className="text-xs rounded-sm" data-testid="tab-tendencia">Tendencia</TabsTrigger>
        </TabsList>

        <TabsContent value="marcas" className="space-y-4 mt-4">
          <Card className="chart-card rounded-sm" data-testid="marca-bar-chart">
            <CardContent className="pt-6 px-4 pb-4">
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={marcas} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="marca" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="total_sales" radius={0} name="Ventas">
                      {marcas.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-sm" data-testid="marca-table-card">
            <CardContent className="pt-5 px-6 pb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Marca</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ventas</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ordenes</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Unidades</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ticket</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">% Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const totalSales = marcas.reduce((s, m) => s + m.total_sales, 0);
                    return marcas.map((row, i) => (
                      <tr key={row.marca} className="data-row border-b border-border/40" data-testid={`marca-row-${i}`}>
                        <td className="py-2.5">
                          <div className="flex items-center gap-2">
                            <div className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[i % COLORS.length] }} />
                            <span className="font-medium">{row.marca}</span>
                          </div>
                        </td>
                        <td className="py-2.5 text-right font-medium">{formatCurrencyFull(row.total_sales)}</td>
                        <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.order_count)}</td>
                        <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.units_sold)}</td>
                        <td className="py-2.5 text-right text-muted-foreground">{formatCurrency(row.avg_ticket)}</td>
                        <td className="py-2.5 text-right text-muted-foreground">{totalSales > 0 ? `${((row.total_sales / totalSales) * 100).toFixed(1)}%` : '-'}</td>
                      </tr>
                    ));
                  })()}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tipos" className="space-y-4 mt-4">
          <Card className="chart-card rounded-sm" data-testid="tipo-bar-chart">
            <CardContent className="pt-6 px-4 pb-4">
              <div className="h-[320px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={tipos} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="tipo" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} angle={-35} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                    <Tooltip content={<ChartTooltip />} />
                    <Bar dataKey="total_sales" radius={0} name="Ventas">
                      {tipos.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
          <Card className="rounded-sm" data-testid="tipo-table-card">
            <CardContent className="pt-5 px-6 pb-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Tipo</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ventas</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ordenes</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Unidades</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ticket</th>
                  </tr>
                </thead>
                <tbody>
                  {tipos.map((row, i) => (
                    <tr key={row.tipo} className="data-row border-b border-border/40" data-testid={`tipo-row-${i}`}>
                      <td className="py-2.5 font-medium">{row.tipo}</td>
                      <td className="py-2.5 text-right font-medium">{formatCurrencyFull(row.total_sales)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.order_count)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.units_sold)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatCurrency(row.avg_ticket)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="tendencia" className="mt-4">
          <Card className="chart-card rounded-sm" data-testid="marca-trend-chart">
            <CardHeader className="pb-2 px-6 pt-5">
              <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
                Evolucion de Marcas por Ano
              </CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={marcaTrend} margin={{ top: 5, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="year" tick={{ fontSize: 11, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000000).toFixed(1)}M`} />
                    <Tooltip content={<ChartTooltip />} />
                    <Legend wrapperStyle={{ fontSize: '11px' }} />
                    {topMarcas.map((m, i) => (
                      <Line key={m} type="monotone" dataKey={m} stroke={COLORS[i % COLORS.length]} strokeWidth={2} dot={{ r: 3 }} name={m} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
