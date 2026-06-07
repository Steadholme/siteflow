import type { ReactNode } from "react";

import type { StatusTone } from "@components/ui/StatusPill";

export interface TimelineItem {
  id: string;
  title: string;
  meta?: string;
  description?: ReactNode;
  tone?: StatusTone;
}

export interface TimelineProps {
  items: TimelineItem[];
  ariaLabel: string;
}

export function Timeline({ items, ariaLabel }: TimelineProps) {
  return (
    <ol className="timeline" aria-label={ariaLabel}>
      {items.map((item) => (
        <li key={item.id} className="timeline__item">
          <span className={["timeline__marker", item.tone ? `timeline__marker--${item.tone}` : undefined].filter(Boolean).join(" ")} aria-hidden="true" />
          <div className="timeline__content">
            <div className="timeline__row">
              <strong>{item.title}</strong>
              {item.meta && <span>{item.meta}</span>}
            </div>
            {item.description && <p>{item.description}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
