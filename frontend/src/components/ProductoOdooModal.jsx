import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from './ui/dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Textarea } from './ui/textarea';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';

const CAMPOS = [
  { key: 'marca_id', label: 'Marca *', cat: 'marcas' },
  { key: 'tipo_id', label: 'Tipo *', cat: 'tipos' },
  { key: 'entalle_id', label: 'Entalle', cat: 'entalles' },
  { key: 'tela_general_id', label: 'Tela general', cat: 'telas-general' },
  { key: 'tela_id', label: 'Tela', cat: 'telas' },
  { key: 'genero_id', label: 'Género *', cat: 'generos' },
  { key: 'cuello_id', label: 'Cuello (solo Polo)', cat: 'cuellos' },
  { key: 'detalle_id', label: 'Detalle', cat: 'detalles' },
  { key: 'lavado_id', label: 'Lavado (Pantalón/Short)', cat: 'lavados' },
];

export default function ProductoOdooModal({ producto, onClose, onSaved }) {
  const [form, setForm] = useState({});
  const [notas, setNotas] = useState('');
  const [catalogos, setCatalogos] = useState({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!producto) return;
    setForm({
      marca_id: producto.marca_id,
      tipo_id: producto.tipo_id,
      entalle_id: producto.entalle_id,
      tela_general_id: producto.tela_general_id,
      tela_id: producto.tela_id,
      genero_id: producto.genero_id,
      cuello_id: producto.cuello_id,
      detalle_id: producto.detalle_id,
      lavado_id: producto.lavado_id,
    });
    setNotas(producto.notas || '');

    (async () => {
      setLoading(true);
      try {
        const keys = CAMPOS.map(c => c.cat);
        const promises = keys.map(k => api.get(`/catalogos/${k}`));
        const results = await Promise.all(promises);
        const map = {};
        keys.forEach((k, i) => { map[k] = results[i].data || []; });
        setCatalogos(map);
      } catch (e) {
        toast.error('Error cargando catálogos');
      } finally { setLoading(false); }
    })();
  }, [producto]);

  const handleSave = async () => {
    if (!producto) return;
    setSaving(true);
    try {
      await api.patch(`/productos-odoo/${producto.id}/clasificar`, { ...form, notas });
      toast.success('Clasificación guardada');
      onSaved();
      onClose();
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setSaving(false); }
  };

  if (!producto) return null;

  return (
    <Dialog open={!!producto} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{producto.odoo_nombre}</DialogTitle>
          <DialogDescription className="text-xs space-y-0.5">
            <div>Odoo dice — marca: <b>{producto.odoo_marca_texto || '—'}</b>, tipo: <b>{producto.odoo_tipo_texto || '—'}</b>, entalle: <b>{producto.odoo_entalle_texto || '—'}</b>, tela: <b>{producto.odoo_tela_texto || '—'}</b></div>
            <div>Estado actual: <span className="font-semibold">{producto.estado}</span>
              {producto.campos_pendientes?.length > 0 && <span className="text-amber-700 ml-2">Pendientes: {producto.campos_pendientes.join(', ')}</span>}
            </div>
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center h-40"><Loader2 className="h-8 w-8 animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-2">
            {CAMPOS.map(c => (
              <div key={c.key} className="space-y-1">
                <Label className="text-xs">{c.label}</Label>
                <Select
                  value={form[c.key] || '__none__'}
                  onValueChange={(v) => setForm(prev => ({ ...prev, [c.key]: v === '__none__' ? null : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin asignar" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— Sin asignar —</SelectItem>
                    {(catalogos[c.cat] || []).map(op => (
                      <SelectItem key={op.id} value={op.id}>{op.nombre}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
            <div className="sm:col-span-2">
              <Label className="text-xs">Notas</Label>
              <Textarea value={notas} onChange={e => setNotas(e.target.value)} rows={2} placeholder="Opcional..." />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || loading}>
            {saving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Guardando...</> : <><Save className="mr-2 h-4 w-4" />Guardar</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
