import { useEffect, useRef, useState } from "react";
import { Input, type InputProps } from "./input";
import { cn } from "@/lib/cn";

interface NumberInputProps extends Omit<InputProps, "value" | "onChange" | "type"> {
  value: number;
  onChange: (n: number) => void;
  /** When true (default), a value of 0 renders as an empty field with a faint "0" placeholder. */
  zeroAsEmpty?: boolean;
}

/**
 * Controlled numeric input that keeps a string buffer internally, so:
 *  - a value of 0 shows as a faint placeholder, not a literal "0" you must delete
 *  - partial entries like "0." or "-" stay typeable
 *  - external value changes (e.g. a live-price fetch, or a form reset) sync in
 */
export function NumberInput({
  value,
  onChange,
  zeroAsEmpty = true,
  placeholder = "0",
  className,
  ...props
}: NumberInputProps) {
  const fmt = (v: number) => (zeroAsEmpty && v === 0 ? "" : String(v));
  const [text, setText] = useState(() => fmt(value));
  const editing = useRef(false);

  // Sync when the external value changes to something the buffer doesn't represent.
  useEffect(() => {
    if (editing.current) return;
    const parsed = text.trim() === "" ? 0 : Number(text);
    if (!(Number.isFinite(parsed) && parsed === value)) setText(fmt(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <Input
      type="number"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      className={cn("placeholder:text-muted-foreground/40", className)}
      onFocus={() => (editing.current = true)}
      onBlur={() => (editing.current = false)}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = raw.trim() === "" ? 0 : Number(raw);
        onChange(Number.isFinite(n) ? n : 0);
      }}
      {...props}
    />
  );
}
