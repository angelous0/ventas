import { useEffect, useMemo, useState } from 'react';
import { api, API } from '../lib/api';
import { Button } from './ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger,
} from './ui/dialog';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { MultiSelect } from './ui/multi-select';
import { Download, Loader2, FileText, ListOrdered, Receipt, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';

const AGRUPACIONES = [
  { value: 'mes', label: 'Mensual (totales)', desc: '~25 filas. Ideal para proyección global de tendencia.' },
  { value: 'mes_marca', label: 'Mensual × Marca', desc: '~80 filas. Tendencia por marca.' },
  { value: 'mes_marca_tipo', label: 'Mensual × Marca × Tipo', desc: '~300 filas. Recomendado para Claude.' },
  { value: 'mes_grupo', label: 'Mensual × Marca × Tipo × Entalle × Tela', desc: '~3,000 filas. Detalle máximo.' },
  { value: 'dia', label: 'Diario (totales)', desc: '~730 filas. Estacionalidad fina.' },
];

// Helpers de fecha
const fmt = (d) => d.toISOString().slice(0, 10);
const today = () => new Date();
const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const endOfMonth = (d)   => new Date(d.getFullYear(), d.getMonth() + 1, 0);

// Presets de rango de fechas. Cada uno devuelve [desde, hasta] como YYYY-MM-DD.
const PRESETS = [
  {
    label: 'Este mes',
    fn: () => { const t = today(); return [fmt(startOfMonth(t)), fmt(t)]; },
  },
  {
    label: 'Mes pasado',
    fn: () => {
      const t = today();
      const m = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      return [fmt(startOfMonth(m)), fmt(endOfMonth(m))];
    },
  },
  {
    label: 'Últimos 3m',
    fn: () => { const t = today(); const d = new Date(t); d.setMonth(d.getMonth() - 3); return [fmt(d), fmt(t)]; },
  },
  {
    label: 'Últimos 12m',
    fn: () => { const t = today(); const d = new Date(t); d.setMonth(d.getMonth() - 12); return [fmt(d), fmt(t)]; },
  },
  {
    label: 'YTD',
    fn: () => { const t = today(); return [fmt(new Date(t.getFullYear(), 0, 1)), fmt(t)]; },
  },
  {
    label: 'Año pasado',
    fn: () => {
      const y = today().getFullYear() - 1;
      return [`${y}-01-01`, `${y}-12-31`];
    },
  },
];

export default function ExportarVentas({ tienda }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('resumen');

  // Catálogos para los multi-selects
  const [optMarcas, setOptMarcas] = useState([]);
  const [optTipos, setOptTipos] = useState([]);
  const [optEntalles, setOptEntalles] = useState([]);
  const [optTelas, setOptTelas] = useState([]);

  // Filtros compartidos por ambas tabs
  const [marcas, setMarcas] = useState([]);
  const [tipos, setTipos] = useState([]);
  const [entalles, setEntalles] = useState([]);
  const [telas, setTelas] = useState([]);

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

  // Cargar catálogos al abrir el dialog (lazy: solo cuando el usuario lo abre)
  useEffect(() => {
    if (!open) return;
    if (optMarcas.length || optTipos.length) return;  // ya cargados
    const map = (rows) => (rows || []).map(r => ({ value: String(r.id), label: r.nombre }));
    Promise.all([
      api.get('/catalogos/marcas').then(r => map(r.data)).catch(() => []),
      api.get('/catalogos/tipos').then(r => map(r.data)).catch(() => []),
      api.get('/catalogos/entalles').then(r => map(r.data)).catch(() => []),
      api.get('/catalogos/telas').then(r => map(r.data)).catch(() => []),
    ]).then(([m, t, e, te]) => {
      setOptMarcas(m); setOptTipos(t); setOptEntalles(e); setOptTelas(te);
    });
  }, [open, optMarcas.length, optTipos.length]);

  const aplicarPreset = (preset, target) => {
    const [d, h] = preset.fn();
    if (target === 'res') { setResDesde(d); setResHasta(h); }
    else                  { setDetDesde(d); setDetHasta(h); }
  };

  const limpiarJerarquia = () => {
    setMarcas([]); setTipos([]); setEntalles([]); setTelas([]);
  };

  const algunaJerarquia = marcas.length || tipos.length || entalles.length || telas.length;

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

  // Append CSV de filtros a URLSearchParams si hay valores
  const aplicarFiltrosJerarquia = (p) => {
    if (marcas.length)   p.set('marcas',   marcas.join(','));
    if (tipos.length)    p.set('tipos',    tipos.join(','));
    if (entalles.length) p.set('entalles', entalles.join(','));
    if (telas.length)    p.set('telas',    telas.join(','));
  };

  const descargarResumen = () => {
    const p = new URLSearchParams({ agrupacion, desde: resDesde, hasta: resHasta });
    if (tienda) p.set('tienda', tienda);
    aplicarFiltrosJerarquia(p);
    descargar('/export/ventas', p);
  };

  const descargarDetalle = () => {
    const p = new URLSearchParams({ desde: detDesde, hasta: detHasta, limit: String(detLimit), nivel: detNivel });
    if (tienda) p.set('tienda', tienda);
    aplicarFiltrosJerarquia(p);
    descargar('/export/ventas-detalle', p);
  };

  const seleccion = AGRUPACIONES.find(a => a.value === agrupacion);

  // Bloque común: presets + 2 inputs date
  const RangoFecha = ({ desde, hasta, setDesde, setHasta, target }) => (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {PRESETS.map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => aplicarPreset(p, target)}
            className="px-2 py-0.5 text-[11px] rounded border border-border hover:bg-muted transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">Desde</Label>
          <Input type="date" value={desde} onChange={e => setDesde(e.target.value)} max={hasta || undefined} />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Hasta</Label>
          <Input type="date" value={hasta} onChange={e => setHasta(e.target.value)} min={desde || undefined} />
        </div>
      </div>
    </div>
  );

  // Bloque común: 4 multi-selects de jerarquía
  const FiltrosJerarquia = () => (
    <div className="space-y-2 border rounded-md p-3 bg-muted/20">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filtros de producto (opcional)
        </Label>
        {algunaJerarquia ? (
          <button
            type="button"
            onClick={limpiarJerarquia}
            className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <XIcon className="h-3 w-3" /> Limpiar
          </button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Marca</Label>
          <MultiSelect options={optMarcas} value={marcas} onChange={setMarcas}
            placeholder="Todas las marcas" emptyText="Sin marcas" className="h-8" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Tipo</Label>
          <MultiSelect options={optTipos} value={tipos} onChange={setTipos}
            placeholder="Todos los tipos" emptyText="Sin tipos" className="h-8" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Entalle</Label>
          <MultiSelect options={optEntalles} value={entalles} onChange={setEntalles}
            placeholder="Todos los entalles" emptyText="Sin entalles" className="h-8" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Tela</Label>
          <MultiSelect options={optTelas} value={telas} onChange={setTelas}
            placeholder="Todas las telas" emptyText="Sin telas" className="h-8" />
        </div>
      </div>
      {algunaJerarquia ? (
        <div className="text-[11px] text-amber-600 dark:text-amber-400">
          ⚠ Se filtra por SKUs clasificados. Productos sin clasificación FK no aparecerán.
        </div>
      ) : null}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-4 w-4" /> Exportar para Claude / Excel
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-primary" /> Exportar ventas a CSV
          </DialogTitle>
          <DialogDescription>
            Todos los filtros del módulo aplicados (venta real, productos descartados, etc.)
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-2">
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
              <RangoFecha desde={resDesde} hasta={resHasta} setDesde={setResDesde} setHasta={setResHasta} target="res" />
              <FiltrosJerarquia />
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
                    ✅ Coincide con el formato del Excel oficial de Odoo POS.
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
              <RangoFecha desde={detDesde} hasta={detHasta} setDesde={setDetDesde} setHasta={setDetHasta} target="det" />
              <FiltrosJerarquia />
              <div className="space-y-1.5">
                <Label className="text-xs">Límite de filas (máx 200,000)</Label>
                <Input type="number" value={detLimit} onChange={e => setDetLimit(Number(e.target.value))} min={100} max={200000} />
                <p className="text-[11px] text-muted-foreground">Si el resultado excede el límite, devuelve las más recientes primero.</p>
              </div>
            </TabsContent>
          </Tabs>

          {tienda && (
            <div className="text-xs text-muted-foreground p-2 rounded bg-muted mt-3">
              📍 Filtro de tienda activo: <b>{tienda}</b>
            </div>
          )}
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancelar</Button>
          {tab === 'resumen' ? (
            <Button onClick={descargarResumen} disabled={loading}>
              {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generando...</> : <><Download className="mr-2 h-4 w-4" />Descargar CSV</>}
            </Button>
          ) : (
            <Button onClick={descargarDetalle} disabled={loading}>
              {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generando...</> : <><Download className="mr-2 h-4 w-4" />Descargar CSV detalle</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
