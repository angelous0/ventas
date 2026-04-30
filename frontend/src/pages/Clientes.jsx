import { useEffect, useState, useCallback } from 'react';
import { api, formatSoles, formatNum } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Skeleton } from '../components/ui/skeleton';
import { Loader2, Users, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useFilters } from '../context/FiltersContext';

export default function Clientes() {
  const { filters } = useFilters();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filtro, setFiltro] = useState(''); // búsqueda local cliente (no global)
  const [orden, setOrden] = useState('ventas'); // local: criterio de orden

  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      const vista = filters.periodo === '12m' ? 'ytd' : filters.periodo;
      const params = { vista, limit: 100, orden };
      if (filters.tiendas.length) params.tienda = filters.tiendas.join(',');
      const res = await api.get('/clientes/top', { params });
      setItems(res.data.items || []);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  }, [orden, filters.periodo, filters.tiendas]);

  useEffect(() => { cargar(); }, [cargar]);

  const filtrados = filtro
    ? items.filter(i => (i.nombre || '').toLowerCase().includes(filtro.toLowerCase()))
    : items;

  if (loading) return (
    <div className="p-6 space-y-5">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-96 w-full" />
    </div>
  );

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Users className="h-6 w-6 text-primary" /> Top clientes
        </h1>
        <p className="text-sm text-muted-foreground">{items.length} clientes con compras YTD 2026</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[250px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar cliente..." value={filtro} onChange={e => setFiltro(e.target.value)} className="pl-9" />
        </div>
        <Select value={orden} onValueChange={setOrden}>
          <SelectTrigger className="w-[220px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="ventas">Por ventas</SelectItem>
            <SelectItem value="tickets">Por tickets</SelectItem>
            <SelectItem value="ticket_promedio">Por ticket promedio</SelectItem>
            <SelectItem value="frecuencia">Por frecuencia (más seguido)</SelectItem>
            <SelectItem value="dias_sin_comprar">Sin comprar hace más</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-auto max-h-[calc(100vh-260px)]">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground border-b bg-muted sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="text-left py-2 px-3">Cliente</th>
                  <th className="text-left py-2 px-3">Ubicación</th>
                  <th className="text-right py-2 px-3">Ventas</th>
                  <th className="text-right py-2 px-3">Tickets</th>
                  <th className="text-right py-2 px-3">Ticket Prom</th>
                  <th className="text-right py-2 px-3">Unidades</th>
                  <th className="text-right py-2 px-3">Frec (d)</th>
                  <th className="text-right py-2 px-3">Sin comprar (d)</th>
                  <th className="text-left py-2 px-3">Tipo</th>
                </tr>
              </thead>
              <tbody>
                {filtrados.map(c => (
                  <tr key={c.cliente_id} className="border-b hover:bg-muted/20">
                    <td className="py-2 px-3 font-medium">{c.nombre || '(sin nombre)'}</td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">
                      {c.city || '—'}{c.state_name ? `, ${c.state_name}` : ''}
                    </td>
                    <td className="text-right tabular-nums py-2 px-3 font-medium">{formatSoles(c.ventas)}</td>
                    <td className="text-right tabular-nums py-2 px-3">{c.tickets}</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatSoles(c.ticket_promedio)}</td>
                    <td className="text-right tabular-nums py-2 px-3">{formatNum(c.unidades)}</td>
                    <td className="text-right tabular-nums py-2 px-3">{c.frecuencia_dias ?? '—'}</td>
                    <td className="text-right tabular-nums py-2 px-3">{c.dias_sin_comprar}</td>
                    <td className="py-2 px-3"><span className="text-xs text-muted-foreground">{c.tipo}</span></td>
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
