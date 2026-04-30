import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Button } from './ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogTrigger,
} from './ui/dialog';
import { RefreshCw, Loader2, Clock, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import { Checkbox } from './ui/checkbox';
import { toast } from 'sonner';

const SEV_COLORS = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
};
const SEV_ICONS = { ok: CheckCircle2, warn: AlertTriangle, danger: XCircle };

function formatLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('es-PE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export default function SyncStatus({ collapsed = false }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [resultados, setResultados] = useState(null);
  const [seleccion, setSeleccion] = useState({});  // {job_code: bool}

  const cargar = async () => {
    try {
      const res = await api.get('/sync/status');
      setStatus(res.data);
      // Inicializar selección: todos true por defecto si está vacío
      setSeleccion(prev => {
        if (Object.keys(prev).length > 0) return prev;
        const init = {};
        (res.data.items || []).forEach(it => { init[it.job_code] = true; });
        return init;
      });
    } catch {
      // silencio
    } finally { setLoading(false); }
  };

  useEffect(() => {
    cargar();
    const id = setInterval(cargar, 60000); // refresh cada minuto
    return () => clearInterval(id);
  }, []);

  const trigger = async () => {
    const seleccionados = Object.entries(seleccion).filter(([, v]) => v).map(([k]) => k);
    if (seleccionados.length === 0) {
      toast.error('Seleccioná al menos un job');
      return;
    }
    if (running) {
      toast.error('Ya hay una sincronización en curso');
      return;
    }
    setRunning(true);
    setResultados(null);
    try {
      toast.info(`Sincronizando ${seleccionados.length} job${seleccionados.length > 1 ? 's' : ''}... puede tardar varios minutos`);
      const res = await api.post('/sync/trigger', { jobs: seleccionados });
      setResultados(res.data.resultados);
      const okCount = res.data.resultados.filter(r => r.ok).length;
      const total = res.data.resultados.length;
      toast.success(`Sincronización completa: ${okCount}/${total} OK`);
      cargar();
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally { setRunning(false); }
  };

  const toggleTodos = (val) => {
    const nuevo = {};
    (status?.items || []).forEach(it => { nuevo[it.job_code] = val; });
    setSeleccion(nuevo);
  };

  if (loading || !status) {
    return null;
  }

  const Icon = SEV_ICONS[status.ventas_severity] || Clock;
  const colorCls = SEV_COLORS[status.ventas_severity] || '';

  if (collapsed) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="icon" className="h-8 w-8" title={`Datos ${status.ventas_freshness}`}>
            <Icon className={`h-4 w-4 ${colorCls}`} />
          </Button>
        </DialogTrigger>
        {renderDialog()}
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="w-full text-left px-3 py-2 text-xs hover:bg-muted rounded transition-colors flex items-center gap-2">
          <Icon className={`h-3.5 w-3.5 shrink-0 ${colorCls}`} />
          <div className="flex-1 min-w-0">
            <div className={`font-medium truncate ${colorCls}`}>Datos {status.ventas_freshness}</div>
            <div className="text-[10px] text-muted-foreground truncate">
              {formatLocal(status.pos_last_run_at)}
            </div>
          </div>
          <RefreshCw className="h-3 w-3 text-muted-foreground" />
        </button>
      </DialogTrigger>
      {renderDialog()}
    </Dialog>
  );

  function renderDialog() {
    return (
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col p-0 gap-0">
        {/* Header fijo arriba */}
        <DialogHeader className="px-6 pt-6 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" /> Estado de sincronización
          </DialogTitle>
          <DialogDescription>
            Las ventas se sincronizan automáticamente con Odoo cada noche. Podés actualizar manualmente cuando quieras.
          </DialogDescription>
        </DialogHeader>

        {/* Contenido scrollable: el min-h-0 + flex-1 hace que tome el alto restante
            entre header y footer y respete max-h-[90vh] del DialogContent. */}
        <div className="flex-1 min-h-0 overflow-y-auto px-6 space-y-4 py-2">
          <div className={`p-3 rounded-md border ${
            status.ventas_severity === 'ok' ? 'bg-emerald-50 border-emerald-200 dark:bg-emerald-950/20 dark:border-emerald-800' :
            status.ventas_severity === 'warn' ? 'bg-amber-50 border-amber-200 dark:bg-amber-950/20 dark:border-amber-800' :
            'bg-red-50 border-red-200 dark:bg-red-950/20 dark:border-red-800'
          }`}>
            <div className="flex items-center gap-2">
              <Icon className={`h-5 w-5 ${colorCls}`} />
              <div>
                <div className="font-semibold text-sm">Última sincronización de ventas: {status.ventas_freshness}</div>
                <div className="text-xs text-muted-foreground">{formatLocal(status.pos_last_run_at)}</div>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Seleccionar qué actualizar</div>
              <div className="flex gap-1.5">
                <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => toggleTodos(true)}>Todos</Button>
                <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => toggleTodos(false)}>Ninguno</Button>
              </div>
            </div>
            <div className="space-y-1.5">
              {status.items.map(it => {
                const I = SEV_ICONS[it.severity] || Clock;
                const checked = !!seleccion[it.job_code];
                return (
                  <label
                    key={it.job_code}
                    className={`flex items-center gap-3 text-sm border rounded p-2 cursor-pointer transition-colors ${checked ? 'bg-muted/50 border-primary/40' : 'hover:bg-muted/30'}`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(v) => setSeleccion(s => ({ ...s, [it.job_code]: !!v }))}
                    />
                    <I className={`h-4 w-4 shrink-0 ${SEV_COLORS[it.severity]}`} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{it.label}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {it.schedule_type === 'DAILY' ? `Diario ${it.run_time_utc} UTC` : `Cada hora`} ·
                        Última: {formatLocal(it.last_run_at)}
                      </div>
                    </div>
                    <div className={`text-xs font-medium ${SEV_COLORS[it.severity]}`}>{it.freshness}</div>
                  </label>
                );
              })}
            </div>
            {seleccion['STOCK_QUANTS'] && (
              <div className="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
                ⚠️ Stock es el job más pesado (puede tardar 5-15 min). Si no necesitás stock actualizado al instante, desmarcá para que el resto termine más rápido.
              </div>
            )}
          </div>

          {resultados && (
            <div>
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Última ejecución manual</div>
              <div className="space-y-1 text-sm">
                {resultados.map(r => (
                  <div key={r.job_code} className="flex items-center gap-2 border rounded p-2">
                    {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <XCircle className="h-4 w-4 text-red-600" />}
                    <span className="font-medium flex-1">{r.job_code}</span>
                    <span className="text-xs text-muted-foreground">{r.rows.toLocaleString('es-PE')} filas · {r.duracion_s}s</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="text-[11px] text-muted-foreground border rounded p-2">
            <div className="font-semibold mb-1">Horario actual de auto-sync (Perú UTC−5):</div>
            <div>Clientes 23:05 · Productos 23:10 · Tallas/Colores 23:12 · Tiendas 23:08 · <b>Ventas POS 23:20</b> · Stock cada hora</div>
          </div>
        </div>

        {/* Footer fijo abajo (siempre visible aunque haya scroll) */}
        <DialogFooter className="px-6 py-4 border-t shrink-0 bg-background">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={running}>Cerrar</Button>
          <Button onClick={trigger} disabled={running}>
            {running ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Sincronizando...</> : <><RefreshCw className="mr-2 h-4 w-4" />Actualizar ahora</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }
}
