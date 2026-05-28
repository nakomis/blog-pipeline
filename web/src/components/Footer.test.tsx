import { render, screen } from '@testing-library/react';
import Footer from './Footer';

test('renders the site footer attribution', () => {
  render(<Footer />);
  expect(
    screen.getByText(/Designed and built by Nakomis/),
  ).toBeInTheDocument();
});
