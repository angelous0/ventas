import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api, formatSoles, formatNum } from '../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Skeleton } from '../components/ui/skeleton';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import { ArrowLeft, Package, Store, Users, Boxes, TrendingUp } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { toast } from 'sonner';

/**
 * Drill-down de un producto específico.
 * Ruta: /productos/:id
 *
 * Muestra:
 * - Header con metadata (marca, tipo, entalle, tela, estado clasif)
 * - Histórico mensual de ventas (LineChart 12m)
 * - Tiendas que lo venden (top)
 * - Clientes top
 * - Stock por ubicación
 */
export default function ProductoDetalle() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/productos/${id}/detalle`, { params: { meses: 12 } })
      .then(r => { if (!cancelled) setData(r.data); })
      .catch(e => {
        if (!cancelled) {
          toast.error('Error: ' + (e.response?.data?.detail || e.message));
          if (e.response?.status === 404) navigate('/productos');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, navigate]);

  if (loading && !data) return <ProductoSkeleton />;
  if (!data) return null;

  const p = data.producto;
  const ventasTotales = data.historico_mensual.reduce((s, m) => s + m.ventas, 0);
  const unidadesTotales = data.historico_mensual.reduce((s, m) => s + m.unidades, 0);
  const ticketsTotales = data.historico_mensual.reduce((s, m) => s + m.tickets, 0);

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mt-1">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Package className="h-6 w-6 text-primary" /> {p.nombre}
            </h1>
            <div className="flex items-center gap-2 flex-wrap mt-1 text-sm text-muted-foreground">
              {p.marca && <Badge variant="outline">{p.marca}</Badge>}
              {p.tipo && <Badge variant="outline">{p.tipo}</Badge>}
              {p.entalle && <Badge variant="outline">{p.entalle}</Badge>}
              {p.tela && <Badge variant="outline">{p.tela}</Badge>}
              {p.estado_clasif && (
                <Badge variant={p.estado_clasif === 'completo' ? 'default' : 'secondary'} className="text-[10px]">
                  {p.estado_clasif}
                </Badge>
              )}
              {p.list_price && <span className="text-xs">· Precio lista: {formatSoles(p.list_price)}</span>}
            </div>
          </div>
        </div>
      </div>

      {/* KPIs resumen */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KPI label="Ventas (12m)" value={formatSoles(ventasTotales)} />
        <KPI label="Unidades (12m)" value={formatNum(unidadesTotales)} />
        <KPI label="Tickets (12m)" value={formatNum(ticketsTotales)} />
        <KPI label="Stock total" value={formatNum(data.stock_total || 0)} accent="amber" />
      </div>

      {/* Histórico mensual */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> Histórico mensual
          </CardTitle>
          <p className="text-xs text-muted-foreground">Últimos {data.meses_consultados || 12} meses</p>
        </CardHeader>
        <CardContent>
          {data.historico_mensual.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Sin ventas en el período.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={data.historico_mensual} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="mes" tick={{ fontSize: 11 }} tickFormatter={fmtMesCorto} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `S/${(v/1000).toFixed(0)}K`} width={60} />
                <RTooltip
                  contentStyle={{ fontSize: 11, padding: '6px 10px', borderRadius: 6 }}
                  formatter={(v, k) => k === 'ventas' ? [formatSoles(v), 'Ventas'] : [formatNum(v), k]}
                  labelFormatter={fmtMesCorto}
                />
                <Line type="monotone" dataKey="ventas" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Grid: Tiendas | Clientes | Stock */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Tiendas */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Store className="h-4 w-4" /> Tiendas que lo venden
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.tiendas.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Sin ventas por tienda.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-1.5 px-3">Tienda</th>
                    <th className="text-right py-1.5 px-3">Und</th>
                    <th className="text-right py-1.5 px-3">Ventas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.tiendas.map(t => (
                    <tr key={t.tienda} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 px-3 font-medium">{t.tienda}</td>
                      <td className="text-right tabular-nums py-1.5 px-3">{formatNum(t.unidades)}</td>
                      <td className="text-right tabular-nums py-1.5 px-3">{formatSoles(t.ventas)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Clientes top */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Users className="h-4 w-4" /> Clientes top
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {data.clientes_top.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Sin clientes.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-1.5 px-3">Cliente</th>
                    <th className="text-right py-1.5 px-3">Und</th>
                    <th className="text-right py-1.5 px-3">Ventas</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clientes_top.map(c => (
                    <tr key={c.cliente_id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 px-3 truncate max-w-[120px]" title={c.nombre}>{c.nombre || '—'}</td>
                      <td className="text-right tabular-nums py-1.5 px-3">{formatNum(c.unidades)}</td>
                      <td className="text-right tabular-nums py-1.5 px-3">{formatSoles(c.ventas)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        {/* Stock por ubicación */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Boxes className="h-4 w-4" /> Stock por ubicación
            </CardTitle>
            <p className="text-[10px] text-muted-foreground">{formatNum(data.stock_total)} unidades en total</p>
          </CardHeader>
          <CardContent className="p-0">
            {data.stock_por_tienda.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">Sin stock activo.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-[10px] text-muted-foreground border-b">
                  <tr>
                    <th className="text-left py-1.5 px-3">Ubicación</th>
                    <th className="text-right py-1.5 px-3">Stock</th>
                  </tr>
                </thead>
                <tbody>
                  {data.stock_por_tienda.map(s => (
                    <tr key={s.tienda} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-1.5 px-3 font-medium">{s.tienda}</td>
                      <td className="text-right tabular-nums py-1.5 px-3 font-semibold">{formatNum(s.stock)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const MES_NOMBRES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
function fmtMesCorto(s) {
  if (!s || typeof s !== 'string') return s;
  const [y, m] = s.split('-');
  const n = parseInt(m, 10);
  const yy = (y || '').slice(-2);
  return n >= 1 && n <= 12 ? `${MES_NOMBRES[n - 1]} ${yy}` : s;
}

function KPI({ label, value, accent }) {
  return (
    <div className={`p-3 rounded-lg ${accent === 'amber' ? 'bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50' : 'bg-muted/30'}`}>
      <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

function ProductoSkeleton() {
  return (
    <div className="p-6 space-y-5">
      <Skeleton className="h-10 w-96" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[1,2,3,4].map(i => <Skeleton key={i} className="h-20" />)}
      </div>
      <Skeleton className="h-56" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {[1,2,3].map(i => <Skeleton key={i} className="h-64" />)}
      </div>
    </div>
  );
}
