import type { ImageCredit } from '../api/image-credit';

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * Dashboard warning shown when fal.ai credit is running low (PIPE-34). Renders
 * nothing while credit is fine — or before the first check has run.
 */
export default function CreditBanner({ credit }: { credit: ImageCredit | null }) {
  if (!credit?.low) {
    return null;
  }

  const remaining =
    credit.remainingUsd === undefined ? 'little' : usd(credit.remainingUsd);
  const estimate = credit.source === 'budget' ? ' (estimated)' : '';
  const threshold =
    credit.thresholdUsd === undefined
      ? ''
      : `, below the ${usd(credit.thresholdUsd)} warning threshold`;

  return (
    <p role="alert" className="app__warning">
      fal.ai image credit is running low: {remaining} remaining{estimate}
      {threshold}. Once it runs out, posts will be staged without their
      illustrations.{' '}
      <a href="https://fal.ai/dashboard/billing" target="_blank" rel="noreferrer">
        Top up on fal.ai
      </a>
    </p>
  );
}
