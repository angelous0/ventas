import { useEffect, useState } from 'react';
import { api, formatSoles, formatNum, formatPct } from '../lib/api';
import { Card, CardContent } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { ChevronRight, Home, Loader2, Layers } from 'lucide-react';
import { toast } from 'sonner';

export default function ExploradorClasificacion() {
  const [path, setPath] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const cargar = async (newPath) => {
    setLoading(true);
    try {
      const res = await api.get('/clasificacion/drill', {
        params: { path: JSON.stringify(newPath), vista: 'ytd', anios_compara: '2025' },
      });
      setData(res.data);
      setPath(newPath);
    } catch (e) {
      toast.error('Error: ' + (e.response?.data?.detail || e.message));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { cargar([]); }, []);

  const drillDown = (item) => {
    if (!item.puede_drill) return;
    cargar([...path, item.id]);
  };
  const irA = (idx) => cargar(path.slice(0, idx));

  if (loading && !data) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="h-8 w-8 animate-spin" /></div>;
  }
  if (!data) return null;

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Layers className="h-6 w-6 text-primary" />
            Explorador de clasificación
          </h1>
          <p className="text-sm text-muted-foreground">
            {data.periodo_actual?.desde} → {data.periodo_actual?.hasta} · Nivel: <span className="font-medium text-foreground">{data.nivel_actual}</span>
          </p>
        </div>
      </div>

      {/* Breadcrumbs */}
      <div className="flex items-center gap-1 flex-wrap text-sm">
        <Button variant="ghost" size="sm" onClick={() => irA(0)} className="h-8 px-2">
          <Home className="h-4 w-4 mr-1" /> Todos
        </Button>
        {data.path_info?.map((p, idx) => (
          <div key={idx} className="flex items-center gap-1">
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
            <Button variant="ghost" size="sm" onClick={() => irA(idx + 1)} className="h-8 px-2">
              <span className="text-xs text-muted-foreground mr-1">{p.nivel}:</span>{p.nombre}
            </Button>
          </div>
        ))}
      </div>

      {/* Total del nivel */}
      <Card>
        <CardContent className="p-4 flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Total del nivel</div>
            <div className="text-2xl font-bold tabular-nums">{formatSoles(data.total_nivel)}</div>
          </div>
          <div className="text-xs text-muted-foreground">{data.items?.length || 0} items</div>
        </CardContent>
      </Card>

      {/* Lista de items */}
      <div className="space-y-2">
        {data.items?.map((it) => {
          const share = it.share_pct || 0;
          return (
            <Card
              key={it.id}
              className={`${it.puede_drill ? 'cursor-pointer hover:border-primary/50 transition-colors' : 'opacity-80'}`}
              onClick={() => drillDown(it)}
            >
              <CardContent className="p-4">
                <div className="flex items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="font-medium">{it.nombre}</span>
                      {it.puede_drill && <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-primary transition-all" style={{ width: `${Math.min(share, 100)}%` }} />
                    </div>
                  </div>
                  <div className="text-right min-w-[180px]">
                    <div className="font-semibold tabular-nums">{formatSoles(it.ventas)}</div>
                    <div className="flex items-center justify-end gap-3 text-xs text-muted-foreground">
                      <span>{formatNum(it.unidades)} und</span>
                      <span>{formatNum(it.tickets)} tkts</span>
                      <span className="font-medium text-foreground">{share.toFixed(1)}%</span>
                    </div>
                    {it.var_vs_2025_pct != null && (
                      <div className={`text-xs font-medium mt-0.5 ${it.var_vs_2025_pct > 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {formatPct(it.var_vs_2025_pct)} vs 2025
                      </div>
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
