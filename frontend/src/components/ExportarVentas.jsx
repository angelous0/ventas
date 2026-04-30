import { useState } from 'react';
import { API } from '../lib/api';
import { Button } from './ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger,
} from './ui/dialog';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Download, Loader2, FileText, ListOrdered, Receipt } from 'lucide-react';
import { toast } from 'sonner';

const AGRUPACIONES = [
  { value: 'mes', label: 'Mensual (totales)', desc: '~25 filas. Ideal para proyección global de tendencia.' },
  { value: 'mes_marca', label: 'Mensual × Marca', desc: '~80 filas. Tendencia por marca.' },
  { value: 'mes_marca_tipo', label: 'Mensual × Marca × Tipo', desc: '~300 filas. Recomendado para Claude.' },
  { value: 'mes_grupo', label: 'Mensual × Marca × Tipo × Entalle × Tela', desc: '~3,000 filas. Detalle máximo.' },
  { value: 'dia', label: 'Diario (totales)', desc: '~730 filas. Estacionalidad fina.' },
];

export default function ExportarVentas({ tienda }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('resumen');

  // Tab Resumen
  const [agrupacion, setAgrupacion] = useState('mes_marca_tipo');
  const [resDesde, setResDesde] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 24);
    return d.toISOString().slice(0, 10);
  });
  const [resHasta, setResHasta] = useState(() => new Date().toISOString().slice(0, 10));

  // Tab Detalle
  const [detDesde, setDetDesde] = useState(() => {
    const d = new Date(); d.setMonth(d.getMonth() - 3);
    return d.toISOString().slice(0, 10);
  });
  const [detHasta, setDetHasta] = useState(() => new Date().toISOString().slice(0, 10));
  const [detLimit, setDetLimit] = useState(50000);
  const [detNivel, setDetNivel] = useState('ticket'); // 'ticket' o 'linea'

  const [loading, setLoading] = useState(false);

  const descargar = async (path, params) => {
    setLoading(true);
    try {
      const token = localStorage.getItem('ventas_token');
      const res = await fetch(`${API}${path}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Error al exportar');
      const blob = await res.blob();
      const filas = res.headers.get('X-Filas') || '?';

      const cd = res.headers.get('Content-Disposition') || '';
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const filename = fnMatch ? fnMatch[1] : 'ventas.csv';

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);

      toast.success(`CSV descargado · ${filas} filas`);
      setOpen(false);
    } catch (e) {
      toast.error('Error: ' + e.message);
    } finally { setLoading(false); }
  };

  const descargarResumen = () => {
    const p = new URLSearchParams({ agrupacion, desde: resDesde, hasta: resHasta });
    if (tienda) p.set('tienda', tienda);
    descargar('/export/ventas', p);
  };

  const descargarDetalle = () => {
    const p = new URLSearchParams({ desde: detDesde, hasta: detHasta, limit: String(detLimit), nivel: detNivel });
    if (tienda) p.set('tienda', tienda);
    descargar('/export/ventas-detalle', p);
  };

  const seleccion = AGRUPACIONES.find(a => a.value === agrupacion);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-4 w-4" /> Exportar para Claude / Excel
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" /> Exportar ventas a CSV
          </DialogTitle>
          <DialogDescription>
            Todos los filtros del módulo aplicados (venta real, productos descartados, etc.)
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="resumen" className="gap-2"><ListOrdered className="h-4 w-4" />Resumen agrupado</TabsTrigger>
            <TabsTrigger value="detalle" className="gap-2"><Receipt className="h-4 w-4" />Detalle por venta</TabsTrigger>
          </TabsList>

          <TabsContent value="resumen" className="space-y-4 py-2">
            <div className="text-xs text-muted-foreground">
              📊 Una fila por <b>período + categoría</b>. Bueno para tendencias, proyecciones, comparativos.
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Granularidad</Label>
              <Select value={agrupacion} onValueChange={setAgrupacion}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {AGRUPACIONES.map(a => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}
                </SelectContent>
              </Select>
              {seleccion && <p className="text-[11px] text-muted-foreground">{seleccion.desc}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Desde</Label>
                <Input type="date" value={resDesde} onChange={e => setResDesde(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Hasta</Label>
                <Input type="date" value={resHasta} onChange={e => setResHasta(e.target.value)} />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancelar</Button>
              <Button onClick={descargarResumen} disabled={loading}>
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generando...</> : <><Download className="mr-2 h-4 w-4" />Descargar CSV</>}
              </Button>
            </DialogFooter>
          </TabsContent>

          <TabsContent value="detalle" className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Nivel de detalle</Label>
              <Select value={detNivel} onValueChange={setDetNivel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ticket">📋 Por ticket (una fila por orden — como Excel oficial Odoo)</SelectItem>
                  <SelectItem value="linea">🔍 Por línea (una fila por producto vendido — máximo detalle)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="text-xs text-muted-foreground p-2 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              {detNivel === 'ticket' ? (
                <>
                  📋 <b>Una fila por orden/ticket</b>. Columnas:<br/>
                  fecha · <b>empresa</b> · ticket · tipo_comprobante · num_comprobante · tienda · cliente · vendedor · pago · estado · qty_total · líneas · total
                  <br/><br/>
                  ✅ Coincide con el formato del Excel oficial de Odoo POS. Incluye empresa (Ambission / ProyectoModa) para distinguir orígenes.
                </>
              ) : (
                <>
                  🔍 <b>Una fila por línea de ticket</b> (cada producto vendido). Columnas:<br/>
                  fecha · ticket · tienda · producto · marca · tipo · entalle · tela · color · talla · qty · precio · descuento · total
                  <br/><br/>
                  ⚠️ <b>Volumen alto</b>: ~250K líneas/año sin filtros.
                </>
              )}
              <br/>
              🕐 Fechas en hora Lima (UTC−5).
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Desde</Label>
                <Input type="date" value={detDesde} onChange={e => setDetDesde(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Hasta</Label>
                <Input type="date" value={detHasta} onChange={e => setDetHasta(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Límite de filas (máx 200,000)</Label>
              <Input type="number" value={detLimit} onChange={e => setDetLimit(Number(e.target.value))} min={100} max={200000} />
              <p className="text-[11px] text-muted-foreground">Si el resultado excede el límite, devuelve las más recientes primero.</p>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancelar</Button>
              <Button onClick={descargarDetalle} disabled={loading}>
                {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generando...</> : <><Download className="mr-2 h-4 w-4" />Descargar CSV detalle</>}
              </Button>
            </DialogFooter>
          </TabsContent>
        </Tabs>

        {tienda && (
          <div className="text-xs text-muted-foreground p-2 rounded bg-muted">
            📍 Filtro de tienda activo: <b>{tienda}</b>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
