import { useEffect, useState } from 'react';
import { api, API } from '../lib/api';
import { Button } from './ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger,
} from './ui/dialog';
import { Label } from './ui/label';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { MultiSelect } from './ui/multi-select';
import { Switch } from './ui/switch';
import { Download, Loader2, Boxes, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';

/**
 * ExportarStock — modal para descargar el stock actual a CSV.
 *
 * Filtros: tienda(s), marca/tipo/entalle/tela (multi), incluir almacenes
 * (TALLER/AP), min_stock. Dos niveles: detalle (modelo×color×talla×tienda)
 * o grupo (marca·tipo·entalle·tela × tienda).
 *
 * Props:
 *   defaultTiendas: string[]  → tiendas pre-seleccionadas (ej. desde filtros globales)
 *   triggerLabel:   string    → label del botón (default "Exportar stock CSV")
 *   compact:        boolean   → si true, botón sin texto (solo icono)
 */
export default function ExportarStock({ defaultTiendas = [], triggerLabel, compact = false }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Catálogos
  const [optTiendas, setOptTiendas] = useState([]);
  const [optMarcas, setOptMarcas] = useState([]);
  const [optTipos, setOptTipos] = useState([]);
  const [optEntalles, setOptEntalles] = useState([]);
  const [optTelas, setOptTelas] = useState([]);

  // Filtros
  const [tiendas, setTiendas] = useState(defaultTiendas);
  const [marcas, setMarcas] = useState([]);
  const [tipos, setTipos] = useState([]);
  const [entalles, setEntalles] = useState([]);
  const [telas, setTelas] = useState([]);
  const [nivel, setNivel] = useState('detalle');  // 'detalle' | 'grupo'
  const [incluirAlmacenes, setIncluirAlmacenes] = useState(true);
  const [minStock, setMinStock] = useState(1);

  // Sincronizar con defaultTiendas si la prop cambia (ej. usuario cambia el filtro global)
  useEffect(() => {
    if (defaultTiendas.length && tiendas.length === 0) {
      setTiendas(defaultTiendas);
    }
    // eslint-disable-next-line
  }, [defaultTiendas.join(',')]);

  // Cargar catálogos al abrir el modal (lazy)
  useEffect(() => {
    if (!open) return;
    if (optMarcas.length || optTipos.length) return;
    const map = (rows) => (rows || []).map(r => ({ value: String(r.id), label: r.nombre }));
    Promise.all([
      api.get('/catalogos/tiendas').then(r => (r.data || []).map(t => ({ value: t.value, label: t.label || t.value }))).catch(() => []),
      api.get('/catalogos/marcas').then(r => map(r.data)).catch(() => []),
      api.get('/catalogos/tipos').then(r => map(r.data)).catch(() => []),
      api.get('/catalogos/entalles').then(r => map(r.data)).catch(() => []),
      api.get('/catalogos/telas').then(r => map(r.data)).catch(() => []),
    ]).then(([t, m, ti, en, te]) => {
      setOptTiendas(t); setOptMarcas(m); setOptTipos(ti); setOptEntalles(en); setOptTelas(te);
    });
  }, [open, optMarcas.length, optTipos.length]);

  const algunFiltro = tiendas.length || marcas.length || tipos.length || entalles.length || telas.length;
  const limpiarFiltros = () => {
    setTiendas([]); setMarcas([]); setTipos([]); setEntalles([]); setTelas([]);
  };

  const descargar = async () => {
    setLoading(true);
    try {
      const p = new URLSearchParams({ nivel, limit: '500000', min_stock: String(minStock) });
      if (tiendas.length)  p.set('tiendas',  tiendas.join(','));
      if (marcas.length)   p.set('marcas',   marcas.join(','));
      if (tipos.length)    p.set('tipos',    tipos.join(','));
      if (entalles.length) p.set('entalles', entalles.join(','));
      if (telas.length)    p.set('telas',    telas.join(','));
      p.set('incluir_almacenes', incluirAlmacenes ? 'true' : 'false');

      const token = localStorage.getItem('ventas_token');
      const res = await fetch(`${API}/export/stock-detalle?${p.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Error al exportar (HTTP ' + res.status + ')');
      const blob = await res.blob();
      const filas = res.headers.get('X-Filas') || '?';

      const cd = res.headers.get('Content-Disposition') || '';
      const fnMatch = cd.match(/filename="([^"]+)"/);
      const filename = fnMatch ? fnMatch[1] : `stock-${nivel}.csv`;

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);

      toast.success(`Stock descargado · ${filas} filas`);
      setOpen(false);
    } catch (e) {
      toast.error('Error: ' + e.message);
    } finally { setLoading(false); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Download className="h-4 w-4" />
          {!compact && (triggerLabel || 'Exportar stock CSV')}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[92vh] flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Boxes className="h-5 w-5 text-primary" /> Exportar stock a CSV
          </DialogTitle>
          <DialogDescription>
            Stock actual con todos los filtros del módulo aplicados (productos válidos, locations internas).
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-2 space-y-4 py-2">
          {/* Nivel */}
          <div className="space-y-1.5">
            <Label className="text-xs">Nivel de detalle</Label>
            <Select value={nivel} onValueChange={setNivel}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="detalle">🔍 Detalle (modelo × color × talla × tienda)</SelectItem>
                <SelectItem value="grupo">📊 Grupo (marca · tipo · entalle · tela × tienda)</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground p-2 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800">
              {nivel === 'detalle' ? (
                <>
                  🔍 <b>Una fila por (modelo, color, talla, tienda)</b>. Columnas:<br/>
                  marca · tipo · entalle · tela · modelo · color · talla · tienda · stock
                  <br/>Volumen típico: <b>30-100K filas</b> sin filtros.
                </>
              ) : (
                <>
                  📊 <b>Una fila por grupo lógico × tienda</b>. Columnas:<br/>
                  marca · tipo · entalle · tela · tienda · modelos · skus · stock
                  <br/>Volumen típico: <b>1-2K filas</b> sin filtros.
                </>
              )}
            </p>
          </div>

          {/* Tiendas */}
          <div className="space-y-1.5">
            <Label className="text-xs">Tienda(s)</Label>
            <MultiSelect options={optTiendas} value={tiendas} onChange={setTiendas}
              placeholder="Todas las tiendas internas activas" emptyText="Sin tiendas" />
          </div>

          {/* Filtros de jerarquía */}
          <div className="space-y-2 border rounded-md p-3 bg-muted/20">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Filtros de producto (opcional)
              </Label>
              {algunFiltro ? (
                <button type="button" onClick={limpiarFiltros}
                  className="text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
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
          </div>

          {/* Opciones */}
          <div className="space-y-2 border rounded-md p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="text-xs">
                <Label className="text-xs">Incluir almacenes (TALLER, AP, REMATE, ZAP)</Label>
                <p className="text-[10px] text-muted-foreground">
                  Si lo desactivás, solo cuenta tiendas comerciales.
                </p>
              </div>
              <Switch checked={incluirAlmacenes} onCheckedChange={setIncluirAlmacenes} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Stock mínimo (filtra filas con stock &lt; N)</Label>
              <Input type="number" min={0} value={minStock}
                onChange={e => setMinStock(Math.max(0, Number(e.target.value) || 0))} />
              <p className="text-[10px] text-muted-foreground">
                Default <b>1</b>: excluye combinaciones con stock 0. Poné <b>0</b> para incluir todo.
              </p>
            </div>
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={loading}>Cancelar</Button>
          <Button onClick={descargar} disabled={loading}>
            {loading ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Generando...</> : <><Download className="mr-2 h-4 w-4" />Descargar CSV</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
