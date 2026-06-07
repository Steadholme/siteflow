import type { HTMLAttributes, ReactNode } from "react";

export type StatusTone = "success" | "warning" | "error" | "info";

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  tone: StatusTone;
  children: ReactNode;
}

export function StatusPill({ tone, children, className, ...props }: StatusPillProps) {
  const classes = ["status-pill", `status-pill--${tone}`, className].filter(Boolean).join(" ");

  return (
    <span className={classes} data-status={tone} {...props}>
      {children}
    </span>
  );
}
