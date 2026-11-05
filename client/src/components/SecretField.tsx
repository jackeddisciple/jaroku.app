import type { CSSProperties, InputHTMLAttributes } from "react";

export function secretFieldAttributes(maskable: boolean): {
  type: "text" | "password";
  autoComplete: "off" | "new-password";
  maskedStyle: boolean;
} {
  return maskable
    ? { type: "text", autoComplete: "off", maskedStyle: true }
    : { type: "password", autoComplete: "new-password", maskedStyle: false };
}

function canMask(): boolean {
  return typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("-webkit-text-security", "disc");
}

const DOTS = { WebkitTextSecurity: "disc" } as CSSProperties;

export function SecretField({ style, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "autoComplete">) {
  const { type, autoComplete, maskedStyle } = secretFieldAttributes(canMask());
  return (
    <input
      {...props}
      type={type}
      autoComplete={autoComplete}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      data-form-type="other"
      style={maskedStyle ? { ...style, ...DOTS } : style}
    />
  );
}
