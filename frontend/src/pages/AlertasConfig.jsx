import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Switch } from '../components/ui/switch';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Loader2, Bell, Save } from 'lucide-react';
import { toast } from 'sonner';

export default function AlertasConfig() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [edits, setEdits] = useState({}); // id -> { umbral_pct, dias_referencia }

  const cargar = async () => {
    setLoading(true);
    try {
      const res = await api.get('/alertas/config');
      setItems(res.data.items || []);
      setEdits({});
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setLoading(false); }
  };

  useEffect(() => { cargar(); }, []);

  const toggle = async (id) => {
    try {
      await api.post(`/alertas/config/${id}/toggle`);
      toast.success('Alerta actualizada');
      cargar();
    } catch (e) { toast.error('Error: ' + e.message); }
  };

  const guardar = async (id) => {
    const body = edits[id];
    if (!body) return;
    try {
      await api.put(`/alertas/config/${id}`, body);
      toast.success('Umbral guardado');
      cargar();
    } catch (e) { toast.error('Error: ' + e.message); }
  };

  const setEdit = (id, campo, val) => {
    setEdits(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [campo]: val === '' ? null : Number(val) } }));
  };

  if (loading) return <div className="flex items-center justify-center h-96"><Loader2 className="h-8 w-8 animate-spin" /></div>;

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Bell className="h-6 w-6 text-primary" /> Configuración de alertas
        </h1>
        <p className="text-sm text-muted-foreground">Ajusta umbrales y activa/desactiva alertas automáticas</p>
      </div>

      <div className="space-y-3">
        {items.map(a => {
          const edit = edits[a.id] || {};
          const tieneUmbral = a.umbral_pct !== null;
          const tieneDias = a.dias_referencia !== null;
          return (
            <Card key={a.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-1">
                      <h3 className="font-semibold">{a.titulo}</h3>
                      <Switch checked={a.activa} onCheckedChange={() => toggle(a.id)} />
                    </div>
                    <p className="text-sm text-muted-foreground">{a.descripcion}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {tieneUmbral && (
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Umbral %</div>
                        <Input
                          type="number"
                          className="w-24 text-sm"
                          defaultValue={a.umbral_pct}
                          onChange={e => setEdit(a.id, 'umbral_pct', e.target.value)}
                        />
                      </div>
                    )}
                    {tieneDias && (
                      <div>
                        <div className="text-xs text-muted-foreground mb-1">Días ref.</div>
                        <Input
                          type="number"
                          className="w-24 text-sm"
                          defaultValue={a.dias_referencia}
                          onChange={e => setEdit(a.id, 'dias_referencia', e.target.value)}
                        />
                      </div>
                    )}
                    {edits[a.id] && Object.keys(edits[a.id]).length > 0 && (
                      <Button size="sm" onClick={() => guardar(a.id)}>
                        <Save className="h-4 w-4 mr-1" />Guardar
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
