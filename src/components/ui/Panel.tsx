import type { ReactNode } from "react";
import { useId } from "react";

export interface PanelProps {
  title?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function Panel({ title, eyebrow, actions, children, className }: PanelProps) {
  const titleId = useId();
  const classes = ["panel", className].filter(Boolean).join(" ");

  return (
    <section className={classes} aria-labelledby={title ? titleId : undefined}>
      {(title || eyebrow || actions) && (
        <header className="panel__header">
          <div>
            {eyebrow && <p className="eyebrow">{eyebrow}</p>}
            {title && (
              <h2 id={titleId} className="panel__title">
                {title}
              </h2>
            )}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}
