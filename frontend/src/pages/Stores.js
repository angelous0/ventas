import { useState, useEffect } from 'react';
import { useFilters } from '../context/FilterContext';
import { api, formatCurrency, formatCurrencyFull, formatNumber, COLORS } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell
} from 'recharts';
import { Download, MapPin } from 'lucide-react';

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

export default function Stores() {
  const { getFilterParams } = useFilters();
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);

  const currentYear = new Date().getFullYear();

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

      {/* Chart */}
      <Card className="chart-card rounded-sm" data-testid="store-bar-chart">
        <CardContent className="pt-6 px-4 pb-4">
          <div className="h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stores} layout="vertical" margin={{ top: 5, right: 20, left: 5, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                <YAxis dataKey="store_code" type="category" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={80} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="total_sales" radius={0} name="Ventas">
                  {stores.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Table */}
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
    </div>
  );
}
