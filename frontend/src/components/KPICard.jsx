import { Card, CardContent } from './ui/card';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, Tooltip as RTooltip } from 'recharts';
import { formatPct } from '../lib/api';

/**
 * KPICard
 *
 * Props:
 *   - label, value, subtitle, variation, icon, accent
 *   - spark: array de números (ej. [120, 135, 110, 145, 160, 180]) → mini línea a la derecha
 *   - sparkFmt: formateador para tooltip (default: número directo)
 */
export function KPICard({ label, value, subtitle, variation, icon: Icon, accent = 'primary', spark, sparkFmt }) {
  const posNeg = variation == null ? null : variation > 0 ? 'pos' : variation < 0 ? 'neg' : 'neu';
  const color = posNeg === 'pos' ? 'text-emerald-600 dark:text-emerald-400'
              : posNeg === 'neg' ? 'text-red-600 dark:text-red-400'
              : 'text-muted-foreground';
  const Arrow = posNeg === 'pos' ? ArrowUp : posNeg === 'neg' ? ArrowDown : Minus;

  // Color del sparkline según tendencia (último vs primero)
  const sparkColor = (() => {
    if (!spark || spark.length < 2) return 'hsl(var(--primary))';
    const trend = spark[spark.length - 1] - spark[0];
    if (trend > 0) return '#10b981'; // emerald-500
    if (trend < 0) return '#ef4444'; // red-500
    return 'hsl(var(--muted-foreground))';
  })();

  const sparkData = spark ? spark.map((v, i) => ({ i, v: Number(v) || 0 })) : null;
  const showSpark = sparkData && sparkData.length >= 2;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-5">
        <div className="flex items-start justify-between mb-2">
          <div className="text-xs font-medium text-muted-foreground tracking-wide uppercase">{label}</div>
          {Icon && <Icon className={`h-4 w-4 text-${accent}`} />}
        </div>
        <div className="flex items-end justify-between gap-2">
          <div className="flex-1 min-w-0">
            <div className="text-2xl font-bold tracking-tight mb-1 truncate">{value}</div>
            <div className="flex items-center justify-between text-xs gap-2">
              {subtitle && <span className="text-muted-foreground truncate">{subtitle}</span>}
              {variation != null && (
                <span className={`flex items-center gap-1 font-medium shrink-0 ${color}`}>
                  <Arrow className="h-3 w-3" />
                  {formatPct(variation)}
                </span>
              )}
            </div>
          </div>
          {showSpark && (
            <div className="w-20 h-10 shrink-0" title="Últimos 6 meses">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={sparkData} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
                  <RTooltip
                    contentStyle={{ fontSize: 10, padding: '2px 6px', borderRadius: 4 }}
                    formatter={(v) => [sparkFmt ? sparkFmt(v) : v, '']}
                    labelFormatter={() => ''}
                    cursor={{ stroke: sparkColor, strokeWidth: 1 }}
                  />
                  <Line type="monotone" dataKey="v" stroke={sparkColor}
                        strokeWidth={1.75} dot={false} activeDot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
