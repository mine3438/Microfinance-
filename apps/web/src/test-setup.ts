import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/**
 * Unmount whatever the last test rendered.
 *
 * Testing Library registers this itself only when Vitest runs with globals
 * enabled, which this project does not — it imports `describe`/`it`/`expect`
 * explicitly. Without it every render accumulates in one document, and a query
 * that should find one element finds three: the current test's, plus two the
 * previous tests left behind. That fails as "found multiple elements", which
 * reads like a bug in the component rather than in the harness.
 */
afterEach(() => {
  cleanup();
});
