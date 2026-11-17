import type { ReactNode } from 'react';

import { useTooltipHandlers } from './Tooltip.tsx';

/** «Як рахується»: the ⓘ next to a number that says where it comes from. */
export const InfoTip = ({ label, children }: { label: string; children: ReactNode }) => {
  const tooltipFor = useTooltipHandlers();
  return (
    <button type="button" className="info" aria-label={`Як рахується: ${label}`} {...tooltipFor(() => children)}>
      ⓘ
    </button>
  );
};

/** A section title with its explainer and an optional link or control on the right. */
export const SectionHead = ({
  title,
  info,
  children,
}: {
  title: string;
  info?: ReactNode;
  children?: ReactNode;
}) => (
  <div className="section-head">
    <h2>
      {title}
      {info !== undefined && <InfoTip label={title}>{info}</InfoTip>}
    </h2>
    {children}
  </div>
);
