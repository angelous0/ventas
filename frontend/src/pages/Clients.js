import { useState, useEffect } from 'react';
import { useFilters } from '../context/FilterContext';
import { api, formatCurrency, formatCurrencyFull, formatNumber, COLORS } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer
} from 'recharts';
import { Download, Users, ChevronRight } from 'lucide-react';

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

export default function Clients() {
  const { getFilterParams } = useFilters();
  const [clients, setClients] = useState([]);
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientYears, setClientYears] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);

  const currentYear = new Date().getFullYear();

  useEffect(() => {
    const fp = getFilterParams();
    setLoading(true);
    api.getTopClients({ ...fp, year: currentYear, limit: 20 })
      .then(data => {
        setClients(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [getFilterParams, currentYear]);

  const handleClientClick = (client) => {
    if (selectedClient?.client_id === client.client_id) {
      setSelectedClient(null);
      setClientYears([]);
      return;
    }
    setSelectedClient(client);
    setDetailLoading(true);
    const fp = getFilterParams();
    api.getClientYears({ ...fp, client_id: client.client_id })
      .then(data => {
        setClientYears(data);
        setDetailLoading(false);
      })
      .catch(() => setDetailLoading(false));
  };

  const handleExport = () => {
    api.exportExcel({ report: 'top-clients', ...getFilterParams(), year: currentYear });
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48 rounded-sm" />
        <Skeleton className="h-80 rounded-sm" />
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="clients-page">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight font-heading leading-none">Clientes</h1>
          <p className="text-sm text-muted-foreground mt-1">Top clientes por volumen de compras ({currentYear})</p>
        </div>
        <Button variant="outline" size="sm" className="rounded-sm text-xs h-8" onClick={handleExport} data-testid="export-clients-btn">
          <Download size={14} className="mr-1.5" /> Excel
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Client list */}
        <Card className="rounded-sm lg:col-span-2" data-testid="clients-table-card">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              Top 20 Clientes
            </CardTitle>
          </CardHeader>
          <CardContent className="px-6 pb-4">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="clients-table">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground w-8">#</th>
                    <th className="text-left py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Cliente</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ventas</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ordenes</th>
                    <th className="text-right py-2.5 text-[10px] tracking-[0.15em] uppercase font-semibold text-muted-foreground">Ticket</th>
                    <th className="w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {clients.map((row, i) => (
                    <tr
                      key={row.client_id}
                      className={`data-row border-b border-border/40 cursor-pointer ${selectedClient?.client_id === row.client_id ? 'bg-muted/60' : ''}`}
                      onClick={() => handleClientClick(row)}
                      data-testid={`client-row-${i}`}
                    >
                      <td className="py-2.5 text-muted-foreground text-xs font-bold">{i + 1}</td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-2">
                          <Users size={13} className="text-muted-foreground/50 shrink-0" />
                          <span className="font-medium truncate max-w-[200px]">{row.client_name}</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right font-medium">{formatCurrencyFull(row.total_sales)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatNumber(row.order_count)}</td>
                      <td className="py-2.5 text-right text-muted-foreground">{formatCurrency(row.avg_ticket)}</td>
                      <td className="py-2.5">
                        <ChevronRight size={14} className={`text-muted-foreground/40 transition-transform duration-200 ${selectedClient?.client_id === row.client_id ? 'rotate-90' : ''}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        {/* Client detail */}
        <Card className="rounded-sm" data-testid="client-detail-card">
          <CardHeader className="pb-2 px-6 pt-5">
            <CardTitle className="text-[10px] tracking-[0.2em] uppercase font-semibold text-muted-foreground">
              {selectedClient ? 'Detalle del Cliente' : 'Seleccione un Cliente'}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-6 pb-4">
            {!selectedClient && (
              <p className="text-sm text-muted-foreground py-8 text-center">
                Haga clic en un cliente para ver su historial
              </p>
            )}
            {selectedClient && detailLoading && (
              <div className="space-y-3 py-4">
                <Skeleton className="h-4 w-full rounded-sm" />
                <Skeleton className="h-40 w-full rounded-sm" />
              </div>
            )}
            {selectedClient && !detailLoading && (
              <div className="space-y-4">
                <div>
                  <p className="font-heading font-bold text-sm truncate">{selectedClient.client_name}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {formatNumber(selectedClient.order_count)} ordenes | Ticket: {formatCurrency(selectedClient.avg_ticket)}
                  </p>
                </div>

                {clientYears.length > 0 && (
                  <div className="h-[200px]" data-testid="client-year-chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={clientYears} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                        <XAxis dataKey="year" tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
                        <YAxis tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v/1000).toFixed(0)}K`} />
                        <Tooltip content={<ChartTooltip />} />
                        <Bar dataKey="total_sales" fill={COLORS[0]} radius={0} name="Ventas" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                <div className="space-y-0" data-testid="client-years-detail">
                  {clientYears.map(yr => (
                    <div key={yr.year} className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
                      <span className="text-sm font-heading font-bold">{yr.year}</span>
                      <div className="text-right">
                        <p className="text-sm font-medium">{formatCurrency(yr.total_sales)}</p>
                        <p className="text-[10px] text-muted-foreground">{formatNumber(yr.order_count)} ordenes</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
