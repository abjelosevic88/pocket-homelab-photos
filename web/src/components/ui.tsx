import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";
export function Button({
  icon,
  children,
  onClick,
  title,
  disabled = false,
  primary = false,
  danger = false,
  type = "button",
}: {
  icon?: string;
  children?: ReactNode;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`btn ${primary ? "primary" : danger ? "danger" : "ghost"} ${!children ? "icon-only" : ""}`}
    >
      {icon && <Icon name={icon} size={18} />} {children}
    </button>
  );
}
export function Empty({
  icon = "image",
  title,
  children,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={32} />
      </div>
      <h2>{title}</h2>
      <div className="muted">{children}</div>
    </div>
  );
}
export function Modal({
  title,
  children,
  close,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    ref.current?.focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
      if (e.key === "Tab") {
        const all = ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,a[href],[tabindex="0"]',
        );
        if (!all?.length) return;
        const first = all[0],
          last = all[all.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === ref.current)
        ) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className={"photo-modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={ref}
        tabIndex={-1}
      >
        <header>
          <h2>{title}</h2>
          <Button icon="x" title="Close dialog" onClick={close} />
        </header>
        {children}
      </div>
    </div>
  );
}
export function ErrorBox({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div className="error-box" role="alert">
      <Icon name="alert-triangle" size={20} />
      <span>{message}</span>
      {retry && <Button onClick={retry}>Try again</Button>}
    </div>
  );
}
