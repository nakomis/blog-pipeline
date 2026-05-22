import { render, screen } from '@testing-library/react';
import App, { PIPELINE_STAGES } from './App';

describe('App', () => {
  test('renders the application title', () => {
    render(<App />);
    expect(
      screen.getByRole('heading', { level: 1, name: 'Blog Pipeline' }),
    ).toBeInTheDocument();
  });

  test('renders a column for every pipeline stage', () => {
    render(<App />);
    for (const stage of PIPELINE_STAGES) {
      expect(
        screen.getByRole('heading', { level: 2, name: stage.label }),
      ).toBeInTheDocument();
    }
  });

  test('shows an empty-state message in each stage', () => {
    render(<App />);
    expect(screen.getAllByText('No posts yet')).toHaveLength(
      PIPELINE_STAGES.length,
    );
  });
});
