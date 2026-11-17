import { useEffect, useState } from 'react';

/** How long the confirmation stays armed. */
const CONFIRM_MS = 3000;

/** A destructive action that asks once more: the first press arms it for a moment, the second does it. */
export const ConfirmButton = ({
  label,
  confirmLabel,
  disabled = false,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  disabled?: boolean;
  onConfirm: () => void;
}) => {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? 'btn del confirm' : 'btn del'}
      disabled={disabled}
      onClick={() => {
        if (armed) onConfirm();
        else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
};
