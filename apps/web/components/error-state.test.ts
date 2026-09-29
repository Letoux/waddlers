import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ErrorState } from './error-state';
import GlobalError from '../app/global-error';
import RootError from '../app/error';

const secret = new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2');

describe('error boundaries', () => {
  it('ErrorState is French and neutral', () => {
    const html = renderToStaticMarkup(createElement(ErrorState, { reset: () => {} }));
    expect(html).toContain('Une erreur est survenue');
    expect(html).toContain('Réessayer');
    expect(html).not.toMatch(/Application error|Internal/i);
  });

  it('global-error owns html/body and never renders the error', () => {
    const html = renderToStaticMarkup(
      createElement(GlobalError, { error: secret, reset: () => {} }),
    );
    expect(html).toMatch(/^<html lang="fr">.*<body>/);
    expect(html).toContain('Réessayer');
    expect(html).not.toContain('ECONNREFUSED');
    expect(html).not.toContain('hunter2');
  });

  it('root error boundary never renders the error', () => {
    const html = renderToStaticMarkup(createElement(RootError, { error: secret, reset: () => {} }));
    expect(html).toContain('Une erreur est survenue');
    expect(html).not.toContain('ECONNREFUSED');
  });
});
