import type { ButtonHTMLAttributes, ReactNode } from "react";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  label: string;
  icon: ReactNode;
}

export function IconButton({ label, icon, className, type = "button", ...props }: IconButtonProps) {
  const classes = ["icon-button", className].filter(Boolean).join(" ");

  return (
    <button aria-label={label} className={classes} title={label} type={type} {...props}>
      {icon}
    </button>
  );
}
