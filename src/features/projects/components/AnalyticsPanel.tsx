import { Activity, Gauge, MousePointerClick, TrendingUp } from "lucide-react";

import { Panel } from "@components/ui/Panel";
import { StatusPill } from "@components/ui/StatusPill";
import type { AnalyticsDashboardReadModel } from "@domain/readModels";

function formatCount(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

function formatVitalValue(value: number) {
  return value < 1 ? value.toFixed(2) : `${Math.round(value)} ms`;
}

function ratingTone(rating: AnalyticsDashboardReadModel["webVitals"][number]["rating"]) {
  if (rating === "good") {
    return "success" as const;
  }

  return rating === "needs_improvement" ? "warning" as const : "error" as const;
}

function ratingLabel(rating: AnalyticsDashboardReadModel["webVitals"][number]["rating"]) {
  return rating === "needs_improvement" ? "Needs work" : rating[0].toUpperCase() + rating.slice(1);
}

export function AnalyticsPanel({
  analytics,
  error
}: {
  analytics?: AnalyticsDashboardReadModel;
  error?: string;
}) {
  if (error) {
    return (
      <Panel title="Web Analytics" eyebrow="Privacy-preserving traffic">
        <p className="projects-empty-note">{error}</p>
      </Panel>
    );
  }

  if (!analytics) {
    return (
      <Panel title="Web Analytics" eyebrow="Privacy-preserving traffic">
        <p className="projects-empty-note">Analytics summary is not available for this project.</p>
      </Panel>
    );
  }

  const metricItems = [
    {
      label: "Pageviews",
      value: formatCount(analytics.totals.pageviews),
      foot: `${analytics.totals.uniquePaths} unique paths`,
      icon: Activity
    },
    {
      label: "Custom events",
      value: formatCount(analytics.totals.customEvents),
      foot: `${analytics.customEvents.length} tracked names`,
      icon: MousePointerClick
    },
    {
      label: "Web vitals",
      value: formatCount(analytics.totals.webVitals),
      foot: `${analytics.webVitals.length} metrics at p75`,
      icon: Gauge
    }
  ];

  return (
    <Panel title="Web Analytics" eyebrow={`Last ${analytics.window}`} className="projects-analytics-panel">
      <div className="projects-analytics-grid" aria-label="Analytics summary">
        {metricItems.map((item) => {
          const Icon = item.icon;

          return (
            <div key={item.label} className="projects-analytics-metric">
              <Icon aria-hidden="true" size={16} />
              <span className="metric-label">{item.label}</span>
              <strong>{item.value}</strong>
              <span className="metric-foot">{item.foot}</span>
            </div>
          );
        })}
      </div>

      <div className="projects-analytics-sections">
        <section aria-labelledby="top-pages-title" className="projects-analytics-section">
          <h3 id="top-pages-title">Top pages</h3>
          {analytics.topPages.length > 0 ? (
            <ol className="projects-analytics-list">
              {analytics.topPages.map((page) => (
                <li key={page.name}>
                  <span className="projects-mono">{page.name}</span>
                  <strong>{formatCount(page.count)}</strong>
                </li>
              ))}
            </ol>
          ) : (
            <p className="projects-empty-note">No pageviews recorded in this window.</p>
          )}
        </section>

        <section aria-labelledby="speed-insights-title" className="projects-analytics-section">
          <h3 id="speed-insights-title">
            <TrendingUp aria-hidden="true" size={16} />
            Speed Insights
          </h3>
          {analytics.webVitals.length > 0 ? (
            <ul className="projects-analytics-list">
              {analytics.webVitals.map((vital) => (
                <li key={vital.name}>
                  <span>
                    <span className="projects-mono">{vital.name}</span>
                    <span className="table-subtext">p75 {formatVitalValue(vital.p75)}</span>
                  </span>
                  <StatusPill tone={ratingTone(vital.rating)}>{ratingLabel(vital.rating)}</StatusPill>
                </li>
              ))}
            </ul>
          ) : (
            <p className="projects-empty-note">No Core Web Vitals recorded in this window.</p>
          )}
        </section>
      </div>
    </Panel>
  );
}
