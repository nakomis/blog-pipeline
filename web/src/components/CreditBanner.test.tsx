import { render, screen } from '@testing-library/react';
import CreditBanner from './CreditBanner';

describe('CreditBanner (PIPE-34)', () => {
  test('renders nothing while credit is fine or unknown', () => {
    const { container, rerender } = render(<CreditBanner credit={null} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<CreditBanner credit={{ low: false, remainingUsd: 40 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  test('shows the live balance and threshold when low', () => {
    render(
      <CreditBanner
        credit={{ low: true, remainingUsd: 3.2, thresholdUsd: 5, source: 'fal' }}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      'fal.ai image credit is running low: $3.20 remaining, below the $5.00 warning threshold.',
    );
    expect(screen.getByRole('link', { name: 'Top up on fal.ai' })).toHaveAttribute(
      'href',
      'https://fal.ai/dashboard/billing',
    );
  });

  test('marks a budget-proxy figure as an estimate', () => {
    render(
      <CreditBanner credit={{ low: true, remainingUsd: 4, source: 'budget' }} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      '$4.00 remaining (estimated).',
    );
  });

  test('copes with a snapshot missing its figures', () => {
    render(<CreditBanner credit={{ low: true }} />);
    expect(screen.getByRole('alert')).toHaveTextContent('little remaining.');
  });
});
