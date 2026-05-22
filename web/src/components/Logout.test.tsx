import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import Logout from './Logout';

describe('Logout', () => {
  test('redirects to the dashboard', () => {
    render(
      <MemoryRouter initialEntries={['/logout']}>
        <Routes>
          <Route path="/logout" element={<Logout />} />
          <Route path="/" element={<div>Dashboard home</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Dashboard home')).toBeInTheDocument();
  });
});
