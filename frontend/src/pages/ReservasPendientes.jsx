import { useEffect, useState } from 'react';
import { api, formatSoles } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Loader2, Clock } from 'lucide-react';
import { toast } from 'sonner';

export default function ReservasPendientes() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get('/reservas/pendientes');
        setData(res.data);
      } catch (e) {
        toast.error('Error: ' + (e.response?.data?.detail || e.message));
      } finally { setLoading(false); }
    })();
  }, []);

  if (loading) return <div className="flex items-center justify-center h-96"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  if (!data) return null;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Clock className="h-6 w-6 text-primary" /> Reservas pendientes
        </h1>
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground">{data.total}</span> reservas activas ·
          Monto retenido: <span className="font-semibold text-foreground">{formatSoles(data.monto_total)}</span>
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[calc(100vh-220px)]">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="text-left py-2 px-3">Fecha</th>
                  <th className="text-right py-2 px-3">Días</th>
                  <th className="text-left py-2 px-3">Cliente</th>
                  <th className="text-left py-2 px-3">Tienda</th>
                  <th className="text-left py-2 px-3">Vendedor</th>
                  <th className="text-left py-2 px-3">Comprobante</th>
                  <th className="text-right py-2 px-3">Líneas</th>
                  <th className="text-right py-2 px-3">Unidades</th>
                  <th className="text-right py-2 px-3">Monto</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(it => {
                  const urgente = it.dias_reserva > 7;
                  // Comprobante: "BE B003-18352" o "NV 006029" o "—" si no hay
                  const comprobante = (it.tipo_comp || it.num_comp)
                    ? [it.tipo_comp, it.num_comp].filter(Boolean).join(' ')
                    : null;
                  return (
                    <tr key={it.order_id} className="border-b hover:bg-muted/20">
                      <td className="py-2 px-3 tabular-nums text-xs">{(it.date_order || '').slice(0, 10)}</td>
                      <td className={`text-right py-2 px-3 font-medium ${urgente ? 'text-red-600' : ''}`}>{it.dias_reserva}d</td>
                      <td className="py-2 px-3">{it.cliente_nombre || '(sin cliente)'}</td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">{it.tienda || it.location_id}</td>
                      <td className="py-2 px-3 text-xs">
                        {it.vendedor_nombre ? (
                          <span title={it.vendedor_origen === 'cajero' ? 'Cajero (sin vendedor asignado)' : 'Vendedor'}>
                            {it.vendedor_nombre}
                            {it.vendedor_origen === 'cajero' && (
                              <span className="text-[9px] text-muted-foreground ml-1 italic">(caja)</span>
                            )}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/60">—</span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-xs tabular-nums">
                        {comprobante
                          ? <span className="font-mono">{comprobante}</span>
                          : <span className="text-muted-foreground/60">—</span>}
                      </td>
                      <td className="text-right tabular-nums py-2 px-3">{it.lineas}</td>
                      <td className="text-right tabular-nums py-2 px-3">{Math.round(it.unidades || 0)}</td>
                      <td className="text-right tabular-nums py-2 px-3 font-medium">{formatSoles(it.monto)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
