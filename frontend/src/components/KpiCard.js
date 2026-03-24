import { Card, CardContent } from '../components/ui/card';
import { TrendingUp, TrendingDown } from 'lucide-react';

export const KpiCard = ({ label, value, change, icon: Icon, testId }) => {
  const isPositive = change != null && change > 0;
  const isNegative = change != null && change < 0;
  const hasChange = change != null && !isNaN(change);

  return (
    <Card
      className="kpi-card rounded-sm border-border"
      data-testid={testId || `kpi-${label.toLowerCase().replace(/\s+/g, '-')}`}
    >
      <CardContent className="p-6">
        <div className="flex items-center justify-between mb-3">
          <span className="text-[10px] tracking-[0.2em] font-semibold text-muted-foreground uppercase">
            {label}
          </span>
          {Icon && <Icon size={15} className="text-muted-foreground/60" />}
        </div>
        <p className="text-2xl font-black tracking-tight font-heading leading-none">
          {value}
        </p>
        {hasChange && (
          <div className={`flex items-center gap-1 mt-3 text-xs font-medium ${
            isPositive ? 'text-emerald-600 dark:text-emerald-400' : isNegative ? 'text-red-500 dark:text-red-400' : 'text-muted-foreground'
          }`}>
            {isPositive ? <TrendingUp size={13} /> : isNegative ? <TrendingDown size={13} /> : null}
            <span>{change > 0 ? '+' : ''}{change.toFixed(1)}% vs anterior</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
