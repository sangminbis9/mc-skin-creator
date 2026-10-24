import type { ButtonHTMLAttributes, ReactNode } from "react";

interface PixelButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "grass" | "gold" | "danger" | "stone" | "ghost";
  small?: boolean;
  children: ReactNode;
}

export function PixelButton({
  variant = "grass",
  small = false,
  children,
  className = "",
  ...rest
}: PixelButtonProps) {
  const variantClass = variant === "grass" ? "" : `px-btn--${variant}`;
  return (
    <button
      type="button"
      className={`px-btn ${variantClass} ${small ? "px-btn--small" : ""} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
