import {
  type AllocationTarget,
  AllocationTargetListSchema,
  type AssetClass,
  AssetClassSchema,
  type Investments,
  type SaveAllocationTargets,
} from '@hroshi/schema';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { describeError, requestJson } from '../api.ts';
import { formatDecimal, formatEur, formatNumber, formatPercent } from '../format.ts';
import { CLASS_COLORS, CLASS_LABELS } from './shared.ts';

/** A drift under this many percentage points is noise from a day's prices. */
const DRIFT_TOLERANCE = 0.02;

const useSaveTargets = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveAllocationTargets) =>
      requestJson({ path: '/investments/targets', method: 'PUT', body: input, schema: AllocationTargetListSchema }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['investments'] }),
  });
};

const parsePercent = (text: string): number | null => {
  if (text.trim() === '') return 0;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value / 100 : null;
};

/** «ціль 30% · +2 п.п.»: how far a class has drifted from what the owner wants. */
export const formatDrift = ({ weight, target }: { weight: number; target: number }) => {
  const drift = weight - target;
  const points = `${drift < 0 ? '−' : '+'}${formatDecimal(Math.abs(drift) * 100)} п.п.`;
  return { label: `ціль ${formatPercent(target)} · ${points}`, off: Math.abs(drift) >= DRIFT_TOLERANCE };
};

/** One percent field per class; the shares are saved together, so they always add up. */
const TargetsForm = ({ data, onDone }: { data: Investments; onDone: () => void }) => {
  const save = useSaveTargets();
  const current = new Map(data.targets.map((target) => [target.assetClass, target.share]));
  const [drafts, setDrafts] = useState<ReadonlyMap<AssetClass, string>>(
    () =>
      new Map(
        AssetClassSchema.options.map((assetClass) => {
          const share = current.get(assetClass);
          return [assetClass, share === undefined ? '' : formatNumber(share * 100, { digits: 1, minDigits: 0 })];
        }),
      ),
  );
  const readDraft = (assetClass: AssetClass) => drafts.get(assetClass) ?? '';
  const parsed = AssetClassSchema.options.map((assetClass) => ({ assetClass, share: parsePercent(readDraft(assetClass)) }));
  const valid = parsed.every((entry) => entry.share !== null);
  const total = parsed.reduce((sum, entry) => sum + (entry.share ?? 0), 0);
  const targets: AllocationTarget[] = parsed.flatMap((entry) =>
    entry.share === null || entry.share === 0 ? [] : [{ assetClass: entry.assetClass, share: entry.share }],
  );
  const totalEur = data.assetClasses.reduce((sum, entry) => sum + entry.eur, 0);

  return (
    <form
      className="inv-targets"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && total <= 1.0001) save.mutate({ targets }, { onSuccess: onDone });
      }}
    >
      {AssetClassSchema.options.map((assetClass) => (
        <label key={assetClass} className="inv-target-field">
          <span>
            <i style={{ background: CLASS_COLORS[assetClass] }} aria-hidden="true" />
            {CLASS_LABELS[assetClass]}
          </span>
          <input
            inputMode="decimal"
            value={readDraft(assetClass)}
            aria-invalid={parsePercent(readDraft(assetClass)) === null}
            onChange={(event) => setDrafts(new Map([...drafts, [assetClass, event.target.value]]))}
          />
          <span className="muted">%</span>
          <span className="small muted num">
            {(parsePercent(readDraft(assetClass)) ?? 0) > 0 && `≈ ${formatEur((parsePercent(readDraft(assetClass)) ?? 0) * totalEur)}`}
          </span>
        </label>
      ))}
      <div className="inv-target-actions">
        <span className={`small ${total > 1.0001 ? 'err' : 'muted'}`}>
          Разом {formatDecimal(total * 100)}%{total > 1.0001 && ' — більше за 100%'}
          {total > 0 && total < 0.9999 && ' — решта без цілі'}
        </span>
        <button type="button" className="btn small" onClick={onDone}>
          Скасувати
        </button>
        <button type="submit" className="btn small primary" disabled={!valid || total > 1.0001 || save.isPending}>
          {save.isPending ? 'Зберігаю…' : 'Зберегти цілі'}
        </button>
      </div>
      {save.isError && <p className="note err">{describeError(save.error)}</p>}
    </form>
  );
};

/** Target shares per asset class: a button until there are any, then the drift sits beside each class. */
export const AllocationTargets = ({ data }: { data: Investments }) => {
  const [editing, setEditing] = useState(false);
  if (editing) return <TargetsForm data={data} onDone={() => setEditing(false)} />;
  return (
    <button type="button" className="btn small" onClick={() => setEditing(true)}>
      {data.targets.length === 0 ? 'Задати цільовий розподіл' : 'Змінити цілі'}
    </button>
  );
};
